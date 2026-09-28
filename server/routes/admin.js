const express = require('express');
const db = require('../db');

const router = express.Router();

// ログイン済み & is_adminフラグが立っているユーザーのみ通す
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
  if (!req.user.is_admin) return res.status(403).json({ error: '管理者権限が必要です' });
  next();
}

router.use(requireAdmin);

// サービス全体の統計(登録ユーザー数・登録チャンネル数など)
router.get('/stats', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const channelCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  res.json({ userCount, channelCount, adminCount });
});

// ユーザー一覧(登録チャンネル数込み)
router.get('/users', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM user_channels uc WHERE uc.user_id = u.id) AS channel_count
       FROM users u
       ORDER BY u.created_at ASC`
    )
    .all();
  res.json(rows);
});

// 管理者フラグの付与・剥奪
router.post('/users/:id/admin', (req, res) => {
  const { id } = req.params;
  const isAdmin = !!req.body.isAdmin;

  const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // 管理者が0人になってしまう操作は禁止(自分自身の権限剥奪などでロックアウトしないように)
  if (!isAdmin && target.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '最後の管理者の権限は剥奪できません' });
    }
  }

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  res.json({ id, isAdmin });
});

module.exports = router;
