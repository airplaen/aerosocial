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

module.exports = upload;
