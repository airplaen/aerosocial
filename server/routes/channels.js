const express = require('express');
const db = require('../db');
const { resolveChannel, checkChannelBroadcasts, fetchRecentUploads } = require('../youtube');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
  next();
}

// 過去配信(アップロード済み動画)のキャッシュをまとめてUPSERTする
function saveRecentUploads(channelId, uploads) {
  const upsert = db.prepare(
    `INSERT INTO channel_recent_uploads
       (channel_id, video_id, title, description, thumbnail_url, duration_seconds, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(channel_id, video_id) DO UPDATE SET
       title = excluded.title, description = excluded.description, thumbnail_url = excluded.thumbnail_url,
       duration_seconds = excluded.duration_seconds, published_at = excluded.published_at,
       fetched_at = excluded.fetched_at`
  );
  for (const v of uploads) {
    upsert.run(channelId, v.videoId, v.title, v.description, v.thumbnailUrl, v.durationSeconds, v.publishedAt);
  }
}

// ログイン中ユーザーが登録しているチャンネル一覧(ステータス + 過去配信候補込み)
router.get('/', requireLogin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.handle, c.title, c.avatar_url,
              s.status, s.video_id, s.video_title, s.video_description, s.thumbnail_url,
              s.scheduled_start, s.actual_start
       FROM user_channels uc
       JOIN channels c ON c.id = uc.channel_id
       LEFT JOIN channel_status s ON s.channel_id = c.id
       WHERE uc.user_id = ?
       ORDER BY uc.sort_order ASC, uc.added_at ASC`
    )
    .all(req.user.id);

  const pastVideosStmt = db.prepare(
    `SELECT video_id AS videoId, title, description, thumbnail_url AS thumbnailUrl, duration_seconds AS durationSeconds
     FROM channel_recent_uploads
     WHERE channel_id = ?
     ORDER BY published_at DESC
     LIMIT 15`
  );

  const withPastVideos = rows.map((row) => ({
    ...row,
    pastVideos: pastVideosStmt.all(row.id),
  }));

  res.json(withPastVideos);
});

// チャンネルを新規登録(ハンドル/URL/チャンネルIDのいずれかを受け付ける)
router.post('/', requireLogin, async (req, res) => {
  const { input } = req.body;
  if (!input || !input.trim()) {
    return res.status(400).json({ error: 'チャンネルのURL・@ハンドル・IDを入力してください' });
  }

  try {
    const info = await resolveChannel(input);
    if (!info) {
      return res.status(404).json({ error: 'チャンネルが見つかりませんでした' });
    }

    db.prepare(
      `INSERT INTO channels (id, handle, title, avatar_url, uploads_playlist_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         handle = excluded.handle,
         title = excluded.title,
         avatar_url = excluded.avatar_url,
         uploads_playlist_id = excluded.uploads_playlist_id`
    ).run(info.id, info.handle, info.title, info.avatarUrl, info.uploadsPlaylistId);

    const already = db
      .prepare('SELECT 1 FROM user_channels WHERE user_id = ? AND channel_id = ?')
      .get(req.user.id, info.id);
    if (already) {
      return res.status(409).json({ error: 'すでに登録済みのチャンネルです' });
    }

    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM user_channels WHERE user_id = ?')
      .get(req.user.id).m;
    db.prepare('INSERT INTO user_channels (user_id, channel_id, sort_order) VALUES (?, ?, ?)').run(
      req.user.id,
      info.id,
      maxOrder + 1
    );

    // 登録直後に一度だけ状態を確認しておく(番組表がすぐ埋まるように)
    try {
      const status = await checkChannelBroadcasts(info.id);
      db.prepare(
        `INSERT INTO channel_status (channel_id, status, video_id, video_title, video_description, thumbnail_url, scheduled_start, actual_start, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel_id) DO UPDATE SET
           status = excluded.status, video_id = excluded.video_id, video_title = excluded.video_title,
           video_description = excluded.video_description,
           thumbnail_url = excluded.thumbnail_url, scheduled_start = excluded.scheduled_start,
           actual_start = excluded.actual_start, updated_at = excluded.updated_at`
      ).run(info.id, status.status, status.videoId, status.videoTitle, status.videoDescription, status.thumbnailUrl, status.scheduledStart, status.actualStart);
    } catch {
      // 初回チェック失敗は無視。次のポーリングで再取得される。
    }

    // 登録直後に過去配信候補も取得しておく(配信していない時のローテーション用)
    try {
      const uploads = await fetchRecentUploads(info.id, info.uploadsPlaylistId);
      saveRecentUploads(info.id, uploads);
    } catch {
      // 初回取得失敗は無視。次の定期ポーリングで再取得される。
    }

    res.status(201).json({ id: info.id, title: info.title, avatarUrl: info.avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'チャンネル情報の取得に失敗しました' });
  }
});

// 登録解除
router.delete('/:channelId', requireLogin, (req, res) => {
  db.prepare('DELETE FROM user_channels WHERE user_id = ? AND channel_id = ?').run(
    req.user.id,
    req.params.channelId
  );
  res.status(204).end();
});

module.exports = router;
