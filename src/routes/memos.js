const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// 手書き対応メモ(ニーボード)機能。VATSIMでのフライト中に使うことを
// 想定し、テキストメモと手描きスケッチ(iPad Pencil等のポインタイベント
// 経由でフロント側がPNGのdata URLとして書き出したもの)を1件のメモに
// 両方持てるようにしている。全ルートで本人のメモしか読み書きできない
// (user_id = req.user.id を必ず条件に含める)。

const TITLE_MAX_LEN = 80;
const TEXT_MAX_LEN = 20000;
// data URL文字列としての上限。express.json側の上限(src/index.jsで設定)
// より先にここで弾いた方が、エラーメッセージを日本語でわかりやすく返せる。
const DRAWING_DATA_MAX_LEN = 6_000_000;

function serializeMemoSummary(row) {
  return {
    id: row.id,
    title: row.title,
    hasDrawing: !!row.drawing_data,
    // 一覧では本文の冒頭だけ(プレビュー用)。全文はGET /:idで取る。
    textPreview: (row.text_content || "").slice(0, 80),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMemoFull(row) {
  return {
    id: row.id,
    title: row.title,
    textContent: row.text_content || "",
    drawingData: row.drawing_data || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// { error } か { values } を返す。partial=trueのときは渡されたキーだけ検証する(PUT用)。
function validateMemoInput(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? "").trim() || "無題のメモ";
    if (title.length > TITLE_MAX_LEN) {
      return { error: `タイトルは${TITLE_MAX_LEN}文字以内で入力してください。` };
    }
    out.title = title;
  }

  if (!partial || body.textContent !== undefined) {
    const textContent = String(body.textContent ?? "");
    if (textContent.length > TEXT_MAX_LEN) {
      return { error: `本文は${TEXT_MAX_LEN}文字以内で入力してください。` };
    }
    out.textContent = textContent;
  }

  if (!partial || body.drawingData !== undefined) {
    const drawingData = body.drawingData;
    if (drawingData === null || drawingData === "" || drawingData === undefined) {
      out.drawingData = null;
    } else if (typeof drawingData !== "string" || !drawingData.startsWith("data:image/png;base64,")) {
      return { error: "手書きデータの形式が不正です。" };
    } else if (drawingData.length > DRAWING_DATA_MAX_LEN) {
      return { error: "手書きデータが大きすぎます。" };
    } else {
      out.drawingData = drawingData;
    }
  }

  return { values: out };
}

// GET /api/memos — 自分のメモ一覧(新しい更新順)。本文全文・手書き画像は含めない。
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, text_content, drawing_data, created_at, updated_at
       FROM memos WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.user.id]
    );
    res.json({ memos: result.rows.map(serializeMemoSummary) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メモ一覧の取得に失敗しました。" });
  }
});

// GET /api/memos/:id — 1件の全文(本文+手書き画像)。
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM memos WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "メモが見つかりません。" });
    res.json({ memo: serializeMemoFull(row) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メモの取得に失敗しました。" });
  }
});

// POST /api/memos — 新規作成。
router.post("/", requireAuth, async (req, res) => {
  const { error, values } = validateMemoInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO memos (id, user_id, title, text_content, drawing_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.user.id, values.title, values.textContent, values.drawingData ?? null]
    );
    const result = await pool.query(`SELECT * FROM memos WHERE id = $1`, [id]);
    res.status(201).json({ memo: serializeMemoFull(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メモの作成に失敗しました。" });
  }
});

// PUT /api/memos/:id — 更新(部分更新可)。
router.put("/:id", requireAuth, async (req, res) => {
  const { error, values } = validateMemoInput(req.body, { partial: true });
  if (error) return res.status(400).json({ error });
  if (!Object.keys(values).length) return res.status(400).json({ error: "更新内容がありません。" });

  try {
    const existing = await pool.query(`SELECT id FROM memos WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    if (!existing.rows[0]) return res.status(404).json({ error: "メモが見つかりません。" });

    const columns = { title: "title", textContent: "text_content", drawingData: "drawing_data" };
    const setClauses = [];
    const params = [];
    let i = 1;
    for (const [key, column] of Object.entries(columns)) {
      if (values[key] === undefined) continue;
      setClauses.push(`${column} = $${i++}`);
      params.push(values[key]);
    }
    setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    params.push(req.params.id, req.user.id);

    await pool.query(
      `UPDATE memos SET ${setClauses.join(", ")} WHERE id = $${i++} AND user_id = $${i}`,
      params
    );

    const result = await pool.query(`SELECT * FROM memos WHERE id = $1`, [req.params.id]);
    res.json({ memo: serializeMemoFull(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メモの更新に失敗しました。" });
  }
});

// DELETE /api/memos/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM memos WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    if (!result.rowCount) return res.status(404).json({ error: "メモが見つかりません。" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メモの削除に失敗しました。" });
  }
});

module.exports = router;
