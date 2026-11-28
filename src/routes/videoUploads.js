const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Chunked video uploads (動画の分割アップロード, 2026-11-28).
//
// A single-request upload is capped at 100MB by the Cloudflare edge in
// front of the site, so videos larger than one chunk are sent in
// 50MB pieces and reassembled here:
//
//   POST /api/video-uploads/init            { size, mime } -> { uploadId, chunkSize }
//   POST /api/video-uploads/:id/chunk       multipart: index, chunk (repeat in order)
//   POST /api/video-uploads/:id/complete    -> { ok: true }
//
// The reassembled file then sits in a dot-directory under the uploads
// dir (not web-served: express.static ignores dotfiles) until
// POST /api/posts claims it via claimVideoUpload() below, which moves
// it into the uploads dir proper under a fresh name. Sessions that are
// never claimed are deleted lazily once they are SESSION_TTL_MS old,
// so abandoned uploads don't accumulate.
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const CHUNK_DIR = path.join(UPLOAD_DIR, ".chunks");
const MAX_VIDEO_BYTES = (Number(process.env.MAX_VIDEO_MB) || 400) * 1024 * 1024;
const CHUNK_BYTES = 50 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MIME_TO_EXT = { "video/mp4": ".mp4", "video/webm": ".webm" };

function ensureChunkDir() {
  fs.mkdirSync(CHUNK_DIR, { recursive: true });
}

function metaPath(uploadId) {
  return path.join(CHUNK_DIR, `${uploadId}.json`);
}

function partPath(uploadId) {
  return path.join(CHUNK_DIR, `${uploadId}.part`);
}

function loadSession(uploadId) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(uploadId), "utf8"));
  } catch {
    return null;
  }
}

function saveSession(uploadId, meta) {
  fs.writeFileSync(metaPath(uploadId), JSON.stringify(meta));
}

function deleteSession(uploadId) {
  fs.unlink(metaPath(uploadId), () => {});
  fs.unlink(partPath(uploadId), () => {});
}

// Removes sessions whose owner never finished/claimed them. Runs on
// init only (at most a directory scan per new upload) — no timer, so
// nothing keeps the process alive or races an in-flight upload beyond
// the TTL grace.
function cleanupStaleSessions() {
  ensureChunkDir();
  const now = Date.now();
  for (const name of fs.readdirSync(CHUNK_DIR)) {
    if (!name.endsWith(".json")) continue;
    const uploadId = name.slice(0, -".json".length);
    const meta = loadSession(uploadId);
    if (!meta || now - meta.createdAt > SESSION_TTL_MS) deleteSession(uploadId);
  }
}

router.post("/init", requireAuth, (req, res) => {
  const { size, mime } = req.body || {};
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    return res.status(400).json({ error: "対応していない動画形式です（MP4 / WebM のみ対応）。" });
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
    return res.status(400).json({
      error: `動画は${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MBまでです。`,
    });
  }
  cleanupStaleSessions();
  const uploadId = crypto.randomUUID();
  fs.writeFileSync(partPath(uploadId), "");
  saveSession(uploadId, {
    ownerId: req.user.id,
    ext,
    size,
    received: 0,
    nextIndex: 0,
    done: false,
    createdAt: Date.now(),
  });
  res.status(201).json({ uploadId, chunkSize: CHUNK_BYTES });
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_BYTES },
});

router.post("/:id/chunk", requireAuth, chunkUpload.single("chunk"), (req, res) => {
  const meta = loadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: "アップロードセッションが見つかりません。" });
  if (meta.ownerId !== req.user.id) return res.status(403).json({ error: "権限がありません。" });
  if (!req.file) return res.status(400).json({ error: "チャンクが送信されていません。" });

  const index = Number(req.body.index);
  if (!Number.isInteger(index) || index !== meta.nextIndex) {
    return res.status(409).json({ error: "チャンクの順序が正しくありません。最初からやり直してください。" });
  }
  if (meta.received + req.file.size > meta.size) {
    deleteSession(req.params.id);
    return res.status(400).json({ error: "宣言されたサイズを超えたため、アップロードを中止しました。" });
  }
  fs.appendFileSync(partPath(req.params.id), req.file.buffer);
  meta.received += req.file.size;
  meta.nextIndex += 1;
  saveSession(req.params.id, meta);
  res.json({ received: meta.received });
});

router.post("/:id/complete", requireAuth, (req, res) => {
  const meta = loadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: "アップロードセッションが見つかりません。" });
  if (meta.ownerId !== req.user.id) return res.status(403).json({ error: "権限がありません。" });
  if (meta.received !== meta.size) {
    return res.status(400).json({
      error: `アップロードが完了していません（${meta.received} / ${meta.size} バイト）。`,
    });
  }
  meta.done = true;
  saveSession(req.params.id, meta);
  res.json({ ok: true });
});

// Moves a completed session's file into the uploads dir under a fresh
// UUID name and returns that filename (the shape createPost expects
// for its videoFile). Throws on any problem; the posts route turns
// that into a 400. Called synchronously on purpose: the rename is
// atomic on the same filesystem and the post insert follows at once.
function claimVideoUpload(uploadId, userId) {
  const meta = loadSession(uploadId);
  if (!meta || meta.ownerId !== userId || !meta.done) {
    throw new Error("動画のアップロードが完了していません。");
  }
  const filename = `${crypto.randomUUID()}${meta.ext}`;
  fs.renameSync(partPath(uploadId), path.join(UPLOAD_DIR, filename));
  fs.unlink(metaPath(uploadId), () => {});
  return filename;
}

module.exports = router;
module.exports.claimVideoUpload = claimVideoUpload;
