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

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new Error("対応していない画像形式です。"));
    cb(null, true);
  },
});

module.exports = upload;
