// Приглашение на Хэллоуин — серверная часть для Cloudflare Workers.
// Страница и картинки раздаются из папки public/, а запросы /api/* обрабатывает
// этот Worker. Все ответы и комментарии хранятся в одном Durable Object
// (встроенное хранилище Cloudflare) вместо файла data/db.json.
//
// Код доступа (необязательно): в панели Cloudflare → Settings →
// Variables and Secrets добавьте секрет SITE_CODE.

import { DurableObject } from "cloudflare:workers";
import seed from "./seed.json";

const LIMITS = { name: 40, text: 600, comments: 2000, body: 16 * 1024 };

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanName(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, LIMITS.name);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Гость опознаётся по секретному токену из его браузера. Хранится только хэш.
async function guestKey(req) {
  const token = String(req.headers.get("x-guest") || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return (await sha256hex(token)).slice(0, 24);
}

function codeOk(req, url, siteCode) {
  if (!siteCode) return true;
  let given = String(req.headers.get("x-access-code") || "");
  try { given = decodeURIComponent(given); } catch (e) {}
  if (!given) given = String(url.searchParams.get("code") || "");
  given = given.trim();
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(siteCode);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > LIMITS.body) throw new Error("too_big");
  try { return JSON.parse(text || "{}"); } catch (e) { throw new Error("bad_json"); }
}

export class Party extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set();
    this.db = null;
    this.pinger = null;
  }

  async load() {
    if (this.db) return this.db;
    let db = await this.ctx.storage.get("db");
    if (!db) {
      // Первый запуск: переносим ответы из старого data/db.json
      db = {
        rsvps: seed && typeof seed.rsvps === "object" ? seed.rsvps : {},
        comments: seed && Array.isArray(seed.comments) ? seed.comments : [],
      };
      await this.ctx.storage.put("db", db);
    }
    this.db = db;
    return db;
  }

  async save() {
    await this.ctx.storage.put("db", this.db);
    this.broadcast();
  }

  publicState(me) {
    const db = this.db;
    const rsvps = Object.entries(db.rsvps).map(([k, r]) => ({
      status: r.status, name: r.name, at: r.at, mine: k === me,
    }));
    const going = new Set(Object.entries(db.rsvps).filter(([, r]) => r.status === "yes").map(([k]) => k));
    const comments = db.comments.map((c) => ({
      id: c.id, name: c.name, text: c.text, at: c.at, mine: c.author === me, going: going.has(c.author),
    }));
    return { rsvps, comments, me: me ? db.rsvps[me] || null : null };
  }

  // ---------- живые обновления (Server-Sent Events) ----------
  write(writer, text) {
    writer.write(new TextEncoder().encode(text)).catch(() => {
      this.clients.delete(writer);
    });
  }

  broadcast() {
    for (const w of this.clients) this.write(w, "event: changed\ndata: 1\n\n");
  }

  openEvents(req) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.clients.add(writer);
    this.write(writer, "retry: 3000\n\n");
    req.signal?.addEventListener("abort", () => {
      this.clients.delete(writer);
      writer.close().catch(() => {});
    });
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        if (!this.clients.size) { clearInterval(this.pinger); this.pinger = null; return; }
        for (const w of this.clients) this.write(w, ": ping\n\n");
      }, 25000);
    }
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    const siteCode = String(this.env.SITE_CODE || "").trim();

    if (p === "/api/config" && req.method === "GET") return json(200, { needCode: !!siteCode });
    if (!codeOk(req, url, siteCode)) return json(401, { error: "bad_code" });
    if (p === "/api/check" && req.method === "GET") return json(200, { ok: true });
    if (p === "/api/events" && req.method === "GET") return this.openEvents(req);

    await this.load();
    const me = await guestKey(req);
    if (p === "/api/state" && req.method === "GET") return json(200, this.publicState(me));
    if (!me) return json(400, { error: "no_guest" });

    try {
      if (p === "/api/rsvp" && req.method === "POST") {
        const body = await readJson(req);
        const status = body.status === "yes" ? "yes" : body.status === "no" ? "no" : null;
        const name = cleanName(body.name);
        if (!status || !name) return json(400, { error: "bad_input" });
        this.db.rsvps[me] = { status, name, at: Date.now() };
        await this.save();
        return json(200, this.publicState(me));
      }

      if (p === "/api/comments" && req.method === "POST") {
        const body = await readJson(req);
        const name = cleanName(body.name);
        const text = String(body.text || "").trim().slice(0, LIMITS.text);
        if (!name || !text) return json(400, { error: "bad_input" });
        if (this.db.comments.length >= LIMITS.comments) return json(507, { error: "full" });
        const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
        this.db.comments.push({ id, author: me, name, text, at: Date.now() });
        await this.save();
        return json(200, this.publicState(me));
      }

      const m = p.match(/^\/api\/comments\/([a-f0-9]{16})$/);
      if (m && req.method === "DELETE") {
        const i = this.db.comments.findIndex((c) => c.id === m[1]);
        if (i === -1) return json(404, { error: "not_found" });
        if (this.db.comments[i].author !== me) return json(403, { error: "not_yours" });
        this.db.comments.splice(i, 1);
        await this.save();
        return json(200, this.publicState(me));
      }
    } catch (e) {
      return json(400, { error: e.message || "bad_request" });
    }

    return json(404, { error: "not_found" });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.PARTY.get(env.PARTY.idFromName("main"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
