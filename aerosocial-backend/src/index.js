require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const authRoutes = require("./routes/auth");
const postRoutes = require("./routes/posts");
const userRoutes = require("./routes/users");

const app = express();

app.set("trust proxy", 1); // running behind Nginx

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Static file serving for uploaded images
app.use("/uploads", express.static(path.resolve(process.env.UPLOAD_DIR || "./uploads")));

// Rate-limit auth endpoints to slow down brute force / spam registration
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/auth", authLimiter, authRoutes);

app.use("/api/posts", postRoutes);
app.use("/api/users", userRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 404 handler
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Error handler (also catches multer errors, e.g. file too large)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "サーバーエラーが発生しました。" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AeroSocial API listening on port ${port}`));
