/* ============================================================
   黄果剧场 · 后端认证/收藏服务
   - 用户库表：web_users / web_sessions / web_favorites（MySQL, 库 hgtv_metadata）
   - 密码哈希：Node crypto.scryptSync（自带，无额外依赖）
   - 会话：随机 32 字节 token，30 天有效
   - 同时托管前端静态文件（WEB_ROOT），并开启 CORS 供本地预览
   运行：MYSQL_PASSWORD=... node auth_server.mjs
   ============================================================ */
import http from "node:http";
import { createPool } from "mysql2/promise";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const PORT = Number(process.env.AUTH_PORT || 8787);
const HOST = "0.0.0.0";
const WEB_ROOT = process.env.WEB_ROOT || "/root/LGTV/web";
const DB_NAME = process.env.MYSQL_DATABASE || "hgtv_metadata";
const R2_ENDPOINT = process.env.R2_ENDPOINT || "https://56f0aa90cad203586e82810a1536c9b6.r2.cloudflarestorage.com";
const R2_BUCKET = process.env.R2_BUCKET || "hgclone";

const db = createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
});

/* ---------- 建表（幂等） ---------- */
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS web_users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      account VARCHAR(191) NOT NULL,
      pass_salt CHAR(32) NOT NULL,
      pass_hash CHAR(128) NOT NULL,
      nickname VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_web_users_account (account)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      token CHAR(64) NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      PRIMARY KEY (token),
      KEY idx_web_sessions_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS web_favorites (
      user_id INT UNSIGNED NOT NULL,
      drama_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, drama_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/* ---------- 密码 ---------- */
function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
function verifyPassword(pw, saltHex, hashHex) {
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(pw, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

/* ---------- 账号 / 会话 ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1\d{10}$/;
const validAccount = (a) => EMAIL_RE.test(a) || PHONE_RE.test(a);
function deriveNickname(acc) {
  if (acc.includes("@")) return acc.split("@")[0].slice(0, 20);
  return acc.slice(0, 3) + "****" + acc.slice(-4);
}
function newToken() { return randomBytes(32).toString("hex"); }
async function createSession(userId) {
  const token = newToken();
  await db.query(
    "INSERT INTO web_sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))",
    [token, userId]
  );
  return token;
}
async function sessionUser(token) {
  if (!token) return null;
  const [rows] = await db.query(
    `SELECT u.id, u.account, u.nickname
       FROM web_sessions s JOIN web_users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

/* ---------- HTTP 工具 ---------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}
function authToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
function queryToken(req) {
  try { return new URL(req.url, "http://x").searchParams.get("token") || ""; } catch { return ""; }
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
};
async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(normalize(WEB_ROOT))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not Found");
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

/* ---------- API 处理器 ---------- */
async function handleRegister(body) {
  const account = String(body.account || "").trim().toLowerCase();
  const password = String(body.password || "");
  const nickname = String(body.nickname || "").trim().slice(0, 40) || deriveNickname(account);
  if (!validAccount(account)) return [400, { ok: false, error: "邮箱或手机号格式不正确" }];
  if (password.length < 6) return [400, { ok: false, error: "密码至少 6 位" }];
  const { salt, hash } = hashPassword(password);
  try {
    const [r] = await db.query(
      "INSERT INTO web_users (account, pass_salt, pass_hash, nickname) VALUES (?,?,?,?)",
      [account, salt, hash, nickname]
    );
    const user = { id: r.insertId, account, nickname };
    const token = await createSession(user.id);
    return [200, { ok: true, token, user }];
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return [409, { ok: false, error: "该账号已注册，请直接登录" }];
    throw e;
  }
}
async function handleLogin(body) {
  const account = String(body.account || "").trim().toLowerCase();
  const password = String(body.password || "");
  const [rows] = await db.query("SELECT * FROM web_users WHERE account = ?", [account]);
  const u = rows[0];
  if (!u || !verifyPassword(password, u.pass_salt, u.pass_hash)) {
    return [401, { ok: false, error: "账号或密码错误" }];
  }
  const token = await createSession(u.id);
  return [200, { ok: true, token, user: { id: u.id, account: u.account, nickname: u.nickname } }];
}

/* ---------- R2 视频流 ---------- */
let _s3 = null;
function getS3() {
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  if (!_s3) {
    _s3 = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

async function streamVideo(req, res, episodeId) {
  const s3 = getS3();
  if (!s3) return json(res, 503, { ok: false, error: "视频服务未配置" });

  const [rows] = await db.query(
    `SELECT a.object_key, a.mime_type
       FROM media_assets a
      WHERE a.episode_id = ? AND a.provider = 'cloudflare-r2'
        AND a.asset_type = 'mp4' AND a.status = 'ready'`,
    [episodeId]
  );
  const asset = rows[0];
  if (!asset) return json(res, 404, { ok: false, error: "视频不存在或尚未就绪" });

  const range = req.headers.range || "";
  try {
    if (req.method === "HEAD") {
      const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: asset.object_key }));
      res.writeHead(200, {
        "Content-Type": asset.mime_type || head.ContentType || "video/mp4",
        "Content-Length": String(head.ContentLength || 0),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: asset.object_key,
      ...(range ? { Range: range } : {}),
    });
    const obj = await s3.send(cmd);
    const headers = {
      "Content-Type": obj.ContentType || asset.mime_type || "video/mp4",
      "Content-Length": String(obj.ContentLength ?? 0),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (range && obj.ContentRange) headers["Content-Range"] = obj.ContentRange;
    res.writeHead(range ? 206 : 200, headers);

    const body = obj.Body;
    if (body && typeof body.pipe === "function") {
      body.on("error", (e) => { console.error("[streamVideo] body error", e); res.destroy(); });
      body.pipe(res);
      return;
    }
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        } catch (e) { console.error("[streamVideo] read error", e); res.destroy(); }
      })();
      return;
    }
    res.end();
  } catch (e) {
    console.error("[streamVideo]", e);
    if (!res.headersSent) return json(res, 502, { ok: false, error: "读取视频失败" });
    res.destroy();
  }
}

/* ---------- 主服务器 ---------- */
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;

  try {
    // 健康检查
    if (method === "GET" && p === "/api/health") return json(res, 200, { ok: true });

    // 认证
    if (method === "POST" && p === "/api/register") {
      const body = await readBody(req);
      return json(res, ...(await handleRegister(body)));
    }
    if (method === "POST" && p === "/api/login") {
      const body = await readBody(req);
      return json(res, ...(await handleLogin(body)));
    }
    if (method === "POST" && p === "/api/logout") {
      const body = await readBody(req).catch(() => ({}));
      const t = authToken(req) || body.token;
      if (t) await db.query("DELETE FROM web_sessions WHERE token = ?", [t]);
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && p === "/api/me") {
      const u = await sessionUser(authToken(req));
      if (!u) return json(res, 401, { ok: false, error: "未登录或登录已过期" });
      return json(res, 200, { ok: true, user: u });
    }

    // 收藏
    if (method === "GET" && p === "/api/favs") {
      const u = await sessionUser(authToken(req));
      if (!u) return json(res, 401, { ok: false, error: "未登录" });
      const [rows] = await db.query(
        "SELECT drama_id FROM web_favorites WHERE user_id = ? ORDER BY created_at DESC", [u.id]
      );
      return json(res, 200, { ok: true, favs: rows.map((r) => String(r.drama_id)) });
    }
    const favMatch = p.match(/^\/api\/favs\/(\d+)$/);
    if (favMatch && (method === "PUT" || method === "DELETE")) {
      const u = await sessionUser(authToken(req));
      if (!u) return json(res, 401, { ok: false, error: "未登录" });
      const dramaId = Number(favMatch[1]);
      if (method === "PUT") {
        await db.query("INSERT IGNORE INTO web_favorites (user_id, drama_id) VALUES (?,?)", [u.id, dramaId]);
        return json(res, 200, { ok: true, added: true });
      }
      await db.query("DELETE FROM web_favorites WHERE user_id = ? AND drama_id = ?", [u.id, dramaId]);
      return json(res, 200, { ok: true, removed: true });
    }

    // 剧集列表（需登录）
    const epMatch = p.match(/^\/api\/drama\/(\d+)\/episodes$/);
    if (epMatch && method === "GET") {
      const u = await sessionUser(authToken(req));
      if (!u) return json(res, 401, { ok: false, error: "请先登录" });
      const dramaId = Number(epMatch[1]);
      const [dramas] = await db.query(
        "SELECT id, title, poster_url, episode_count FROM dramas WHERE id = ?", [dramaId]
      );
      if (!dramas[0]) return json(res, 404, { ok: false, error: "剧集不存在" });
      const [rows] = await db.query(
        `SELECT e.id, e.episode_number, e.title, e.is_locked, e.trial_seconds,
                a.object_key, a.status AS asset_status, a.size_bytes
           FROM episodes e
           LEFT JOIN media_assets a ON a.episode_id = e.id
             AND a.provider = 'cloudflare-r2' AND a.asset_type = 'mp4'
          WHERE e.drama_id = ?
          ORDER BY e.episode_number`, [dramaId]
      );
      const episodes = rows.map((r) => ({
        id: r.id,
        episode_number: r.episode_number,
        title: r.title,
        is_locked: !!r.is_locked,
        trial_seconds: r.trial_seconds,
        ready: r.asset_status === "ready" && !!r.object_key,
        size_bytes: r.size_bytes,
      }));
      return json(res, 200, { ok: true, drama: dramas[0], episodes });
    }

    // 视频流（需登录；token 走 query，因为 <video> 无法携带 Authorization 头）
    const vidMatch = p.match(/^\/api\/video\/(\d+)$/);
    if (vidMatch && (method === "GET" || method === "HEAD")) {
      const u = await sessionUser(queryToken(req));
      if (!u) return json(res, 401, { ok: false, error: "请先登录" });
      return await streamVideo(req, res, Number(vidMatch[1]));
    }

    // 静态文件
    return await serveStatic(res, p);
  } catch (e) {
    console.error("[auth_server]", e);
    return json(res, 500, { ok: false, error: "服务器内部错误" });
  }
});

await ensureSchema();
server.listen(PORT, HOST, () => {
  console.log(`[auth_server] listening on http://${HOST}:${PORT}  web=${WEB_ROOT}  db=${DB_NAME}`);
});
