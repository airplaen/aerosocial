// src/routes/news.js
//
// ニュースパネル(人気のフライトパネルの下部)用の読み取り専用API。
// 実際の取得・保存・WebSocket配信は services/newsFeed.js が裏で常時
// 行っているので、ここは news_items テーブルを読むだけ。ログイン不要
// (未ログインの訪問者にもニュースは見せる — quakeパネルと同じ方針)。
const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/news?limit=30
// 最新順(公開日時が無い記事は取得日時)で返す。初回ロード時と、WS再接続
// 直後に「その間に来た分」を補うために使う。
router.get("/", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const result = await pool.query(
    `SELECT id, title, summary, link, source, category, image_url AS "imageUrl",
            is_breaking AS "isBreaking", published_at AS "publishedAt", created_at AS "createdAt"
       FROM news_items
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT $1`,
    [limit]
  );
  // SQLiteはbooleanを0/1で返すので、フロントが素直に扱えるよう真偽値化する。
  const items = result.rows.map((r) => ({ ...r, isBreaking: !!r.isBreaking }));
  res.json({ items });
});

module.exports = router;
