const jwt = require("jsonwebtoken");
const pool = require("../db");

// Requires a valid Bearer token. Attaches { id, callsign } to req.user.
//
// Also re-checks is_banned against the database on every request (rather
// than only at login) — better-sqlite3 is synchronous and this is a single
// indexed lookup, so the added latency is negligible, and it means a ban
// takes effect immediately instead of waiting up to JWT_EXPIRES_IN for the
// user's existing token to expire.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "認証トークンがありません。" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query("SELECT is_banned FROM users WHERE id = $1", [payload.id]);
    if (!result.rows[0]) return res.status(401).json({ error: "認証トークンが無効です。" });
    if (result.rows[0].is_banned) return res.status(403).json({ error: "このアカウントは停止されています。" });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "認証トークンが無効です。" });
  }
}

// Attaches req.user if a valid token is present, but does not require one.
// Banned users are simply treated as anonymous here rather than rejected —
// this middleware is used on public/read routes, so there's nothing to
// block; requireAuth above is what actually stops a banned user from
// posting, liking, etc.
async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const result = await pool.query("SELECT is_banned FROM users WHERE id = $1", [payload.id]);
      if (result.rows[0] && !result.rows[0].is_banned) req.user = payload;
    } catch {
      /* ignore invalid token, treat as anonymous */
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
