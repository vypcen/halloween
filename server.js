// Сервер приглашения на Хэллоуин.
// Без внешних зависимостей: нужен только Node.js 18+.
// Запуск: node server.js   (порт можно поменять: PORT=3000 node server.js)
// Код доступа для гостей (необязательно): SITE_CODE=тыква node server.js

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const SITE_CODE = (process.env.SITE_CODE || "").trim();
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const LIMITS = { name: 40, text: 600, comments: 2000, body: 16 * 1024 };

// ---------- база в файле ----------
let db = { rsvps: {}, comments: [] };
function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.rsvps = raw.rsvps && typeof raw.rsvps === "object" ? raw.rsvps : {};
    db.comments = Array.isArray(raw.comments) ? raw.comments : [];
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Не удалось прочитать базу, начинаю с пустой:", e.message);
  }
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}
function flushDb() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}

// Гость опознаётся по секретному токену из его браузера.
// В базе хранится только хэш токена.
function guestKey(req) {
  const token = String(req.headers["x-guest"] || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function cleanName(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, LIMITS.name);
}

function publicState(me) {
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
const clients = new Set();
function broadcast() {
  for (const res of clients) res.write("event: changed\ndata: 1\n\n");
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

// ---------- http ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > LIMITS.body) { reject(new Error("too_big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}
function codeOk(req, url) {
  if (!SITE_CODE) return true;
  let given = String(req.headers["x-access-code"] || "");
  try { given = decodeURIComponent(given); } catch (e) {}
  if (!given) given = String(url.searchParams.get("code") || "");
  given = given.trim();
  const a = Buffer.from(given), b = Buffer.from(SITE_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Не найдено"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);

  // Статика: только index.html и папка images
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, path.join(ROOT, "index.html"));
  if (req.method === "GET" && p.startsWith("/images/")) {
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(path.join(ROOT, "images") + path.sep)) return send(res, 400, { error: "bad_path" });
    return serveFile(res, file);
  }

  if (!p.startsWith("/api/")) return send(res, 404, { error: "not_found" });

  if (p === "/api/config" && req.method === "GET") return send(res, 200, { needCode: !!SITE_CODE });
  if (!codeOk(req, url)) return send(res, 401, { error: "bad_code" });
  if (p === "/api/check" && req.method === "GET") return send(res, 200, { ok: true });

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const me = guestKey(req);
  if (p === "/api/state" && req.method === "GET") return send(res, 200, publicState(me));
  if (!me) return send(res, 400, { error: "no_guest" });

  try {
    if (p === "/api/rsvp" && req.method === "POST") {
      const body = await readJson(req);
      const status = body.status === "yes" ? "yes" : body.status === "no" ? "no" : null;
      const name = cleanName(body.name);
      if (!status || !name) return send(res, 400, { error: "bad_input" });
      db.rsvps[me] = { status, name, at: Date.now() };
      saveDb(); broadcast();
      return send(res, 200, publicState(me));
    }

    if (p === "/api/comments" && req.method === "POST") {
      const body = await readJson(req);
      const name = cleanName(body.name);
      const text = String(body.text || "").trim().slice(0, LIMITS.text);
      if (!name || !text) return send(res, 400, { error: "bad_input" });
      if (db.comments.length >= LIMITS.comments) return send(res, 507, { error: "full" });
      db.comments.push({ id: crypto.randomBytes(8).toString("hex"), author: me, name, text, at: Date.now() });
      saveDb(); broadcast();
      return send(res, 200, publicState(me));
    }

    const m = p.match(/^\/api\/comments\/([a-f0-9]{16})$/);
    if (m && req.method === "DELETE") {
      const i = db.comments.findIndex((c) => c.id === m[1]);
      if (i === -1) return send(res, 404, { error: "not_found" });
      if (db.comments[i].author !== me) return send(res, 403, { error: "not_yours" });
      db.comments.splice(i, 1);
      saveDb(); broadcast();
      return send(res, 200, publicState(me));
    }
  } catch (e) {
    return send(res, 400, { error: e.message || "bad_request" });
  }

  return send(res, 404, { error: "not_found" });
});

loadDb();
server.listen(PORT, HOST, () => {
  const os = require("os");
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("🎃 Приглашение запущено");
  console.log("   На этом компьютере:  http://localhost:" + PORT);
  ips.forEach((ip) => console.log("   В домашней сети:     http://" + ip + ":" + PORT));
  console.log(SITE_CODE ? "   Код доступа включён." : "   Код доступа выключен (задайте SITE_CODE, чтобы включить).");
  console.log("   База: " + DB_FILE);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushDb(); process.exit(0); });
