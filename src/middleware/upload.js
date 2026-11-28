const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const uploadDir = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// "image/jpg" isn't a registered MIME type, but some cameras/OS upload
// dialogs and older browsers report it instead of the correct
// "image/jpeg" for .jpg files, so both are accepted here.
const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

// Max number of images accepted on a single post (see posts.js, which uses
// upload.array("images", MAX_FILES_PER_POST)).
const MAX_FILES_PER_POST = 6;

const upload = multer({
  storage,
  limits: {
    fileSize: (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024,
    files: MAX_FILES_PER_POST,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new Error("対応していない画像形式です。"));
    cb(null, true);
  },
});

upload.MAX_FILES_PER_POST = MAX_FILES_PER_POST;

// Post attachments (動画投稿, 2026-11-28): a post takes the usual images
// plus at most one video. This needs its own multer instance because the
// shared one above rejects non-image MIME types and caps every file at
// the image size limit. The per-file cap here is the video cap; the
// posts route re-checks image sizes against IMAGE_MAX_BYTES itself and
// rejects oversized images after upload.
const VIDEO_ALLOWED = new Set(["video/mp4", "video/webm"]);
const IMAGE_MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
const VIDEO_MAX_BYTES = (Number(process.env.MAX_VIDEO_MB) || 400) * 1024 * 1024;

const uploadPostMedia = multer({
  storage,
  limits: {
    fileSize: VIDEO_MAX_BYTES,
    files: MAX_FILES_PER_POST + 1,
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "video") {
      if (!VIDEO_ALLOWED.has(file.mimetype)) {
        return cb(new Error("対応していない動画形式です（MP4 / WebM のみ対応）。"));
      }
      return cb(null, true);
    }
    if (!ALLOWED.has(file.mimetype)) return cb(new Error("対応していない画像形式です。"));
    cb(null, true);
  },
});
uploadPostMedia.IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
uploadPostMedia.VIDEO_MAX_BYTES = VIDEO_MAX_BYTES;
upload.postMedia = uploadPostMedia;

module.exports = upload;
