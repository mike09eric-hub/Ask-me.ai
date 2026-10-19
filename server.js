import express from "express";
import helmet from "helmet";
import session from "express-session";
import connectSqlite3 from "connect-sqlite3";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const app = express();
const SQLiteStore = connectSqlite3(session);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATABASE_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "askme.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    answer_chars INTEGER NOT NULL DEFAULT 0,
    error_code TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSetting = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
if (!getSetting.get("model")) setSetting.run("model", process.env.GEMINI_MODEL || "gemini-2.5-flash");
if (!getSetting.get("provider")) setSetting.run("provider", "gemini");

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    scriptSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"]
  }
}}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn("WARNING: Set SESSION_SECRET to a random value of at least 32 characters.");
}
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR, concurrentDB: true }),
  name: "askme.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret-before-deploy",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

const askLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });

function requireAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: "Admin sign-in required." });
  next();
}
function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");
  if (!req.session?.csrfToken || !token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "Security token expired. Refresh the page and try again." });
  }
  next();
}
function safeErrorCode(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return status ? String(status) : "UPSTREAM_ERROR";
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "ask-me-ai", timestamp: new Date().toISOString() }));
app.get("/api/admin/csrf", (req, res) => {
  req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken });
});
app.post("/api/admin/login", loginLimiter, requireCsrf, async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  if (!hash || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: "Admin credentials are not configured on the server." });
  }
  const valid = username === expectedUser && await bcrypt.compare(password, hash);
  if (!valid) return res.status(401).json({ error: "Incorrect username or password." });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not create secure session." });
    req.session.admin = true;
    req.session.username = expectedUser;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.json({ ok: true, csrfToken: req.session.csrfToken });
  });
});
app.post("/api/admin/logout", requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ authenticated: true, username: req.session.username }));
app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const total = db.prepare("SELECT COUNT(*) n FROM requests").get().n;
  const today = db.prepare("SELECT COUNT(*) n FROM requests WHERE date(created_at)=date('now')").get().n;
  const failures = db.prepare("SELECT COUNT(*) n FROM requests WHERE status='error'").get().n;
  const recent = db.prepare("SELECT created_at,model,status,prompt_chars,answer_chars,error_code FROM requests ORDER BY id DESC LIMIT 12").all();
  const days = db.prepare(`SELECT date(created_at) day, COUNT(*) requests,
    SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM requests WHERE created_at >= datetime('now','-6 days')
    GROUP BY date(created_at) ORDER BY day`).all();
  res.json({ total, today, failures, success: total - failures, keyConfigured: Boolean(process.env.GEMINI_API_KEY), provider: getSetting.get("provider")?.value || "gemini", model: getSetting.get("model")?.value || "gemini-2.5-flash", recent, days });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({ provider: getSetting.get("provider")?.value || "gemini", model: getSetting.get("model")?.value || "gemini-2.5-flash", keyConfigured: Boolean(process.env.GEMINI_API_KEY) });
});
app.put("/api/admin/settings", requireAdmin, requireCsrf, (req, res) => {
  const provider = String(req.body?.provider || "");
  const model = String(req.body?.model || "").trim();
  if (provider !== "gemini") return res.status(400).json({ error: "Only Gemini is connected in this initial backend release." });
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(model)) return res.status(400).json({ error: "Invalid model identifier." });
  setSetting.run("provider", provider);
  setSetting.run("model", model);
  res.json({ ok: true, provider, model });
});

app.post("/api/ask", askLimiter, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt || prompt.length > 12000) return res.status(400).json({ error: "Enter a question of up to 12,000 characters." });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "AI is not configured yet. Add the server-side GEMINI_API_KEY." });
  const model = getSetting.get("model")?.value || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    if (!response.ok) {
      db.prepare("INSERT INTO requests(model,status,prompt_chars,error_code) VALUES(?,?,?,?)").run(model, "error", prompt.length, String(response.status));
      return res.status(502).json({ error: "The AI provider could not complete this request. Try again shortly." });
    }
    const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!answer) throw new Error("EMPTY_AI_RESPONSE");
    db.prepare("INSERT INTO requests(model,status,prompt_chars,answer_chars) VALUES(?,?,?,?)").run(model, "success", prompt.length, answer.length);
    res.json({ answer, model });
  } catch (error) {
    db.prepare("INSERT INTO requests(model,status,prompt_chars,error_code) VALUES(?,?,?,?)").run(model, "error", prompt.length, safeErrorCode(error));
    res.status(502).json({ error: "Unable to reach the AI service. Please try again." });
  }
});

app.use(express.static("public", { extensions: ["html"] }));
app.get("/admin", (_req, res) => res.sendFile(path.resolve("public/admin.html")));
app.get("*", (_req, res) => res.sendFile(path.resolve("public/index.html")));

app.listen(PORT, () => console.log(`Ask Me.ai backend listening on port ${PORT}`));
