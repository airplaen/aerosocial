require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const postRoutes = require("./routes/posts");
const userRoutes = require("./routes/users");
const simbriefRoutes = require("./routes/simbrief");
const { initWebSocket } = require("./ws");

const app = express();

app.set("trust proxy", 1); // running behind Cloudflare Tunnel / Nginx

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// helmet's default Content-Security-Policy only allows `img-src 'self' data:`,
// which blocks `blob:` URLs — the composer's image preview uses
// URL.createObjectURL(file), i.e. a blob: URL, so without this override the
// preview <img> is silently blocked by the browser (shows as a broken image
// icon, no console-visible app error). Uploaded post images served from
// /uploads are same-origin ('self') and were never affected by this.
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "blob:"],
    },
  },
}));
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

// SimBrief calls out to an external API on every request, so keep it
// modestly rate-limited independent of the general traffic.
const simbriefLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/simbrief", simbriefLimiter, simbriefRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Serve the built frontend from the same server/port -----------------
// Build the React app (npm run build in aerosocial-frontend) and copy its
// dist/ contents into a "public" folder next to this backend's src/ folder.
// If that folder doesn't exist, the API simply runs standalone as before.
const frontendDir = path.resolve(__dirname, "..", "public");
const hasFrontend = fs.existsSync(path.join(frontendDir, "index.html"));

if (hasFrontend) {
  app.use(express.static(frontendDir));
  // Any non-API, non-upload route falls back to index.html so client-side
  // routing (if added later) keeps working on page refresh.
  app.get(/^(?!\/api|\/uploads).*/, (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

// 404 handler (only reached for /api/* and /uploads/* routes that don't match)
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Error handler (also catches multer errors, e.g. file too large)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "サーバーエラーが発生しました。" });
});

// WebSocket needs to share the same HTTP server as Express (it hijacks the
// HTTP "upgrade" event), so we create the server explicitly instead of
// using app.listen() directly.
const server = http.createServer(app);
initWebSocket(server, allowedOrigins);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`AeroSocial API listening on port ${port}`);
  console.log(hasFrontend ? "Serving bundled frontend from /public" : "Frontend not bundled — API only");
  console.log(`WebSocket endpoint: ws(s)://<host>:${port}/ws`);
});
