const pool = require("../db");

// Must run AFTER requireAuth (req.user.id must already be set).
//
// Deliberately re-checks is_admin / is_banned against the database on
// every request instead of trusting a claim baked into the JWT — that way
// revoking admin rights (or banning an admin) takes effect immediately,
// rather than waiting up to JWT_EXPIRES_IN for their existing token to
// expire.
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query("SELECT is_admin, is_banned FROM users WHERE id = $1", [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "ユーザーが見つかりません。" });
    if (user.is_banned) return res.status(403).json({ error: "このアカウントは停止されています。" });
    if (!user.is_admin) return res.status(403).json({ error: "管理者権限が必要です。" });
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "権限確認に失敗しました。" });
  }
}

module.exports = { requireAdmin };
