require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const authRoutes = require("./routes/auth");
const postRoutes = require("./routes/posts");
const userRoutes = require("./routes/users");
const simbriefRoutes = require("./routes/simbrief");
const weatherRoutes = require("./routes/weather");
const youtubeRoutes = require("./routes/youtube");
const notificationRoutes = require("./routes/notifications");
const settingsRoutes = require("./routes/settings");
const adminRoutes = require("./routes/admin");
const adsRoutes = require("./routes/ads");
const eventRoutes = require("./routes/events");
const animeImageRoutes = require("./routes/animeImage");
const newsRoutes = require("./routes/news");
const memoRoutes = require("./routes/memos");
const { initWebSocket } = require("./ws");
const { initDiscordBot } = require("./services/discordNotify");
const { startNewsFeed } = require("./services/newsFeed");

const app = express();

app.set("trust proxy", 1); // running behind Cloudflare Tunnel / Nginx

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A fresh, unguessable nonce per request, used by script-src below (via
// 'strict-dynamic') and stamped into index.html's <script> tags (see
// sendIndexHtml further down). Must run before helmet() so its CSP
// directive functions can read res.locals.cspNonce.
app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

// helmet's default Content-Security-Policy only allows `img-src 'self' data:`,
// which blocks `blob:` URLs — the composer's image preview uses
// URL.createObjectURL(file), i.e. a blob: URL, so without this override the
// preview <img> is silently blocked by the browser (shows as a broken image
// icon, no console-visible app error). Uploaded post images served from
// /uploads are same-origin ('self') and were never affected by this.
// The directives are further widened to allow the Leaflet map library
// (loaded from unpkg for the flight-detail route map) and the
// OpenStreetMap tile images it fetches.
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // https://i.ytimg.com serves YouTube's video thumbnails, used by the
      // click-to-play YouTube card in a post's text (see youtubeCardHtml in
      // app.js).
      // Ad creatives (AdSense) and, especially, AdMax's RTB cookie-sync
      // pixels are served from a long and shifting list of ad-tech domains
      // (bidswitch.net, ad-stir.com, dsp.bance.jp, fout.jp, adm.shinobi.jp,
      // ...) — allowlisting each one individually is a losing game since
      // AdMax's SSP partners change over time. <img> tags can't execute
      // script, so broadly allowing any HTTPS image host here is a much
      // smaller security trade-off than it would be for scripts (below).
      "img-src": ["'self'", "data:", "blob:", "https:"],
      // https://accounts.google.com/gsi/client is the Google Identity
      // Services script that renders the "Googleでログイン" button (see
      // setupGoogleSignIn in app.js).
      //
      // The admin panel's 広告 tab (see openAdminPanelModal in app.js)
      // lets an admin paste an arbitrary ad network's embed snippet, which
      // is then injected verbatim into the feed for every visitor (see
      // injectHtmlWithScripts / renderFeedList). AdMax's actual delivery
      // script (auto.js / t.js) in turn dynamically loads scripts from a
      // long, shifting chain of its own DSP/SSP partners (dmp.im-apps.net,
      // sync.shinobi.jp, js.miyuki-web.net/<numbers that change per ad
      // unit>, ...) — curating a domain allowlist for that is a losing
      // game, the same problem img-src had above, but far riskier to solve
      // the same way (`https:` in script-src would let literally any
      // injected script tag anywhere on the page load and run arbitrary
      // code — the exact thing CSP's script-src exists to prevent).
      //
      // Instead this uses a nonce + 'strict-dynamic': app.js is the only
      // script directly trusted (via the nonce stamped into its <script>
      // tag by sendIndexHtml below); 'strict-dynamic' then extends that
      // trust to anything app.js itself creates via the DOM (see
      // injectHtmlWithScripts), and transitively to whatever *that*
      // script loads in turn — regardless of its domain — without ever
      // needing to list ad-tech domains here. 'https:' and 'unsafe-inline'
      // are ignored by any browser that understands 'strict-dynamic' /
      // nonces; they're kept only as a fallback for older browsers that
      // don't, so the app still works there (just without this extra XSS
      // protection, same as before this change).
      "script-src": ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`, "'strict-dynamic'", "https:", "'unsafe-inline'"],
      // Without an explicit frame-src, helmet's default falls back to
      // default-src 'self', which silently blocks the YouTube embed iframe
      // that replaces the thumbnail once a video card is clicked, and (once
      // added below) Google's sign-in button/One Tap iframe. Ad units
      // (AdSense, AdMax, ...) also commonly render inside an iframe served
      // from whichever ad-tech domain won the auction — same "too many,
      // too shifting to allowlist" reasoning as img-src above; an iframe's
      // content is confined to its own origin regardless, so this is a
      // comparable trade-off.
      "frame-src": ["https://www.youtube.com", "https://accounts.google.com", "https:"],
      // IMPORTANT: helmet's default style-src is ["'self'", "https:", "'unsafe-inline'"]
      // — the app renders lots of literal style="..." attributes in its HTML
      // strings (e.g. flightCardHtml, avatarHtml), which need 'unsafe-inline'.
      // Extend the default array rather than replacing it, or all of those
      // get silently blocked by the browser.
      "style-src": [...helmet.contentSecurityPolicy.getDefaultDirectives()["style-src"], "https://unpkg.com"],
      // Leaflet's bundled file references its sourcemap (leaflet.js.map),
      // fetched only when devtools are open; Cloudflare's beacon script
      // (auto-injected when the site is proxied through Cloudflare, see
      // script-src above) also reports back to cloudflareinsights.com.
      // accounts.google.com is where the Google Identity Services script
      // itself sends the credential-exchange requests behind the sign-in
      // button. api.p2pquake.net is P2P地震情報's public earthquake-info
      // service (see connectQuakeWS in app.js) — the browser connects to
      // it directly over WebSocket (wss://) rather than through this
      // server, so both the wss: and https: origins need to be allowed
      // here or the connection is silently blocked by CSP.
      // api-realtime-sandbox.p2pquake.net is the same service's public
      // sandbox feed, used by the quake panel's "テスト表示" button (see
      // connectQuakeSandboxWS in app.js) to preview the panel with
      // simulated data without waiting for a real earthquake. `https:` is
      // included (same reasoning as img-src/frame-src above) since ad
      // partners' scripts also issue their own fetch()/XHR calls — 'self'
      // and the wss: entries stay explicit since `https:` doesn't cover
      // either of those.
      "connect-src": ["'self'", "https:", "wss://api.p2pquake.net", "wss://api-realtime-sandbox.p2pquake.net"],
    },
  },
}));
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
// 4mb: メモ機能(手書きスケッチをPNGのdata URLとしてJSONボディに含めて
// 送る、src/routes/memos.js)を通すため、既存の1mbから引き上げ。
app.use(express.json({ limit: "4mb" }));
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

// OpenWeatherMapも外部APIを毎リクエスト叩くため、SimBriefと同水準の
// レート制限をかける(地震パネル下部の検索窓からの呼び出しのみ)。
const weatherLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
app.use("/api/weather", weatherLimiter, weatherRoutes);

// One YouTube card can appear per post, and the frontend caches results per
// video id (see youtubeMetaCache in app.js), so this stays far lighter than
// the SimBrief limiter — the generous cap is mainly a guard against a feed
// full of distinct, uncached videos loading all at once.
const youtubeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
app.use("/api/youtube", youtubeLimiter, youtubeRoutes);

app.use("/api/notifications", notificationRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/memos", memoRoutes);

// アニメの紹介画像(Wikipediaに無い場合のフォールバック)をJikan API
// (MyAnimeList)から取ってくるプロキシ。Weather/YouTubeと同じく外部APIを
// 毎リクエスト叩くため、同水準のレート制限をかける(Jikan自体も3req/秒,
// 60req/分の制限があるので、それより厳しくならない範囲で設定)。
const animeImageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
app.use("/api/anime-image", animeImageLimiter, animeImageRoutes);

// ニュースパネル(人気のフライトパネル下部)。取得自体はservices/newsFeed.js
// が裏で定期ポーリングしてDBに貯めているだけなので、ここはDB読み出しのみ
// ——外部APIを毎リクエスト叩くweather/youtube/anime-imageほど厳しい制限は
// 不要。未ログインの訪問者にも見せるため認証なし(quakeパネルと同方針)。
app.use("/api/news", newsRoutes);

// FSA自動投稿ON/OFF設定など、ユーザーごとの設定値を扱うAPI。
// routes/settings.js の GET/PATCH /fsa-auto-post がここにぶら下がる。
app.use("/api/settings", settingsRoutes);
app.use("/api/internal/fsa-flight-post", require("./routes/fsaFlightPost"));

// Public ad config for the feed (see routes/ads.js) — no auth, since
// logged-out visitors load the feed too. Deliberately outside the
// adminLimiter/requireAdmin chain below; the write side of this lives at
// PUT /api/admin/ads, gated the same as every other admin route.
app.use("/api/ads", adsRoutes);

// Admin panel API — every route inside routes/admin.js already requires
// requireAuth + requireAdmin (is_admin flag), so no extra gate is needed
// here. A separate, tighter rate limit keeps the login step (which goes
// through /api/auth, already limited above) and repeated admin actions
// from being brute-forceable in practice even by a stolen admin token.
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use("/api/admin", adminLimiter, adminRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Serve the built frontend from the same server/port -----------------
// Build the React app (npm run build in aerosocial-frontend) and copy its
// dist/ contents into a "public" folder next to this backend's src/ folder.
// If that folder doesn't exist, the API simply runs standalone as before.
const frontendDir = path.resolve(__dirname, "..", "public");
const indexHtmlPath = path.join(frontendDir, "index.html");
const hasFrontend = fs.existsSync(indexHtmlPath);
// Read once at startup rather than on every request — index.html itself
// never changes at runtime, only the nonce stamped into it per-request
// below (see the script-src comment above for why: it's what lets app.js
// be trusted by 'strict-dynamic').
const indexHtmlTemplate = hasFrontend ? fs.readFileSync(indexHtmlPath, "utf8") : null;

if (hasFrontend) {
  // index.html is excluded here (index: false) and served separately by
  // sendIndexHtml below instead, so every request gets a fresh nonce in
  // its <script> tags. Every other static asset (app.js, styles.css,
  // sw.js, ...) is unaffected and still served as plain static files.
  app.use(express.static(frontendDir, { index: false }));

  function sendIndexHtml(_req, res) {
    // Every <script> tag in index.html — including bare `<script>` blocks
    // with no attributes (e.g. the inline gtag snippets), not just ones
    // like `<script src=...>` that are followed by a space — needs this
    // nonce attribute to be trusted at all under 'strict-dynamic' — see
    // the script-src comment above. The previous regex (/<script /g) only
    // matched tags with a trailing space before an attribute, so bare
    // `<script>` tags never got a nonce and were silently blocked by CSP.
    // Any future <script> tag added directly to index.html will need it too.
    const html = indexHtmlTemplate.replace(/<script(\s|>)/g, (_match, sep) => `<script nonce="${res.locals.cspNonce}"${sep}`);
    res.type("html").send(html);
  }

  app.get("/", sendIndexHtml);
  // Any non-API, non-upload route falls back to index.html so client-side
  // routing (if added later) keeps working on page refresh.
  app.get(/^(?!\/api|\/uploads).*/, sendIndexHtml);
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
// Discord Bot通知。トークン未設定の場合はモジュール内で警告を出して
// サイレントに無効化されるだけなので、他の環境変数と同様ここで無条件に
// 呼んでおけばよい。
initDiscordBot();
// ニュースパネルのポーリング開始。initWebSocket() より後に呼ぶ必要がある
// (newsFeed.js は新着記事を検知するたびbroadcast()を呼ぶため)。
// APITUBE_API_KEY未設定の場合はモジュール内で警告を出して無効化される。
startNewsFeed();

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`AeroSocial API listening on port ${port}`);
  console.log(hasFrontend ? "Serving bundled frontend from /public" : "Frontend not bundled — API only");
  console.log(`WebSocket endpoint: ws(s)://<host>:${port}/ws`);
});
