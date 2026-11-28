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
//   POST /api/video-uploads/:id/chunk       multipart: index, chunk (any order, parallel OK)
//   POST /api/video-uploads/:id/complete    -> { ok: true }
//
// Chunks are stored as individual files (<id>.chunk-<index>) so the
// client can upload several at once; /complete concatenates them in
// index order once every chunk is present and the byte total matches
// the size declared at /init. Re-sending a chunk overwrites it, which
// makes client retries idempotent. The reassembled file then sits in
// a dot-directory under the uploads dir (not web-served:
// express.static ignores dotfiles) until POST /api/posts claims it
// via claimVideoUpload() below. Sessions that are never claimed are
// deleted lazily once they are SESSION_TTL_MS old.
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const CHUNK_DIR = path.join(UPLOAD_DIR, ".chunks");
const MAX_VIDEO_BYTES = (Number(process.env.MAX_VIDEO_MB) || 800) * 1024 * 1024;
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

function chunkPath(uploadId, index) {
  return path.join(CHUNK_DIR, `${uploadId}.chunk-${index}`);
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
  try {
    for (const name of fs.readdirSync(CHUNK_DIR)) {
      if (name.startsWith(`${uploadId}.`)) fs.unlink(path.join(CHUNK_DIR, name), () => {});
    }
  } catch { /* chunk dir may not exist yet */ }
}

function receivedBytes(meta) {
  return Object.values(meta.chunkSizes || {}).reduce((a, b) => a + b, 0);
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
  saveSession(uploadId, {
    ownerId: req.user.id,
    ext,
    size,
    chunkSizes: {},
    done: false,
    createdAt: Date.now(),
  });
  res.status(201).json({ uploadId, chunkSize: CHUNK_BYTES });
});

// Chunks land on disk under a temporary name first; the handler moves
// each one to its indexed name after validating the session, so a
// chunk's stored position never depends on multipart field order.
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureChunkDir();
      cb(null, CHUNK_DIR);
    },
    filename: (req, _file, cb) => cb(null, `${req.params.id}.incoming-${crypto.randomUUID()}`),
  }),
  // Headroom over CHUNK_BYTES on purpose: busboy's limiter can trip
  // on a file that is exactly at the limit, and the handler below
  // enforces the exact expected chunk size anyway — this cap is only
  // a guard against absurd single-request bodies.
  limits: { fileSize: CHUNK_BYTES + 1024 * 1024 },
});

router.post("/:id/chunk", requireAuth, chunkUpload.single("chunk"), (req, res) => {
  const fail = (status, message) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(status).json({ error: message });
  };
  const meta = loadSession(req.params.id);
  if (!meta) return fail(404, "アップロードセッションが見つかりません。");
  if (meta.ownerId !== req.user.id) return fail(403, "権限がありません。");
  if (meta.done) return fail(409, "このアップロードは既に完了しています。");
  if (!req.file) return res.status(400).json({ error: "チャンクが送信されていません。" });

  const index = Number(req.body.index);
  const totalChunks = Math.ceil(meta.size / CHUNK_BYTES);
  if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
    return fail(400, "チャンクの番号が正しくありません。");
  }
  // Every chunk except the last is exactly CHUNK_BYTES; the last one
  // is the remainder. Anything else means the client sliced wrong.
  const expectedSize = index === totalChunks - 1
    ? meta.size - CHUNK_BYTES * (totalChunks - 1)
    : CHUNK_BYTES;
  if (req.file.size !== expectedSize) {
    return fail(400, "チャンクのサイズが正しくありません。");
  }

  fs.renameSync(req.file.path, chunkPath(req.params.id, index));
  meta.chunkSizes[index] = req.file.size;
  saveSession(req.params.id, meta);
  res.json({ received: receivedBytes(meta) });
});

router.post("/:id/complete", requireAuth, async (req, res) => {
  const meta = loadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: "アップロードセッションが見つかりません。" });
  if (meta.ownerId !== req.user.id) return res.status(403).json({ error: "権限がありません。" });

  const totalChunks = Math.ceil(meta.size / CHUNK_BYTES);
  const present = Object.keys(meta.chunkSizes || {}).length;
  if (present !== totalChunks || receivedBytes(meta) !== meta.size) {
    return res.status(400).json({
      error: `アップロードが完了していません（${present} / ${totalChunks} チャンク）。`,
    });
  }

  // Concatenate the chunks in index order into the .part file the
  // claim step expects, then drop the chunk files.
  const out = fs.createWriteStream(partPath(req.params.id));
  try {
    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(chunkPath(req.params.id, i));
        rs.on("error", reject);
        rs.on("end", resolve);
        rs.pipe(out, { end: false });
      });
    }
  } catch (err) {
    out.destroy();
    fs.unlink(partPath(req.params.id), () => {});
    console.error("video chunk assembly failed:", err);
    return res.status(500).json({ error: "動画の結合に失敗しました。" });
  }
  await new Promise((resolve) => out.end(resolve));
  for (let i = 0; i < totalChunks; i++) fs.unlink(chunkPath(req.params.id, i), () => {});

  meta.done = true;
  meta.chunkSizes = {};
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
