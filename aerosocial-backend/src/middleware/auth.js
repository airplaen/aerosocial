const jwt = require("jsonwebtoken");

// Requires a valid Bearer token. Attaches { id, callsign } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "認証トークンがありません。" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "認証トークンが無効です。" });
  }
}

// Attaches req.user if a valid token is present, but does not require one.
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      /* ignore invalid token, treat as anonymous */
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
