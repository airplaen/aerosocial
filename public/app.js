(() => {
  "use strict";

  const root = document.getElementById("root");

  // Esri(ArcGIS)の無料ベースマップ。いずれもAPIキー不要。
  // 注意: このタイルは {z}/{y}/{x} の順（OSM系タイルと x/y が逆）。
  const BASEMAP_STYLES = [
    {
      id: "street",
      label: "地図",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, (c) OpenStreetMap contributors, and the GIS User Community",
    },
    {
      id: "topo",
      label: "地形図",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS, (c) OpenStreetMap contributors, and the GIS User Community",
    },
    {
      id: "satellite",
      label: "衛星写真",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  ];
  const TILE_URL = BASEMAP_STYLES[0].url;
  const TILE_SUBDOMAINS = "";
  const TILE_MAX_ZOOM = 19;
  const TILE_ATTRIBUTION = BASEMAP_STYLES[0].attribution;

  const TOKEN_KEY = "aerosocial_token";
  const SIMBRIEF_USERNAME_KEY = "aerosocial_simbrief_username";
  const WARNING_AREA_KEY = "aerosocial_warning_area";
  const THEME_KEY = "aerosocial_theme";
  // 運営メッセージの「未読」バッジ用。既読管理はサーバーに持たせていない
  // (announcementsテーブルは送信履歴のみ)ので、最後に開いた時点の最新
  // メッセージIDをブラウザ側に覚えておくだけの簡易な仕組み。ユーザーIDを
  // 混ぜているのは、同じブラウザで複数アカウントを使い分けた場合に
  // 別々のアカウントの既読状態を取り違えないようにするため。
  const MESSAGES_LAST_SEEN_KEY_PREFIX = "aerosocial_msgs_last_seen_";

  // ---------------------------------------------------------------- theme (light/dark)
  // The actual light/dark palette lives entirely in CSS custom properties
  // (see :root[data-theme="light"] in styles.css) — this just flips the
  // `data-theme` attribute on <html>, persists the choice, and keeps the
  // toggle icon(s) / PWA theme-color meta tag in sync. The attribute is
  // already set once, synchronously, by the inline script in index.html
  // (before first paint, so switching themes never flashes the other
  // theme first) — this only needs to react to it from here on.
  function getTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function syncThemeToggleIcons() {
    const nextIcon = getTheme() === "light" ? "dark_mode" : "light_mode";
    document.querySelectorAll(".theme-toggle-icon").forEach((el) => { el.textContent = nextIcon; });
    const label = document.getElementById("menu-theme-toggle-label");
    if (label) label.textContent = getTheme() === "light" ? "ダークモードに切替" : "ライトモードに切替";
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode etc. — theme just won't persist */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f4f5fa" : "#05070d");
    syncThemeToggleIcons();
  }

  function toggleTheme() {
    setTheme(getTheme() === "light" ? "dark" : "light");
  }

  // Sync the theme-color meta tag with whatever the bootstrap script in
  // index.html already picked (saved preference, else OS setting).
  setTheme(getTheme());


  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: null,
    posts: [],
    commentsByPost: {},
    openComments: new Set(),
    wsConnected: false,
    lightboxUrl: null,
    profileModalOpen: false,
    booted: false,
    // Whether the logged-in user has admin rights (GET /api/admin/me
    // succeeds). Re-checked on every login/boot rather than trusted from
    // the JWT, since the server itself re-checks is_admin on every request
    // too (see middleware/requireAdmin.js) — a revoked admin's button
    // should disappear next time they load the app, not linger forever.
    isAdmin: false,
    error: "",
    composerFiles: [],
    composerPreviewUrls: [],
    submitting: false,
    // A flight card fetched from SimBrief, waiting to be attached to the
    // next post the user submits from the composer.
    pendingFlight: null,
    // Poll builder state (投票機能), while composing a new post — null
    // means "no poll being built" (same on/off pattern as pendingFlight).
    // `options` always has at least POLL_MIN_OPTIONS entries; the UI adds
    // blank ones up to POLL_MAX_OPTIONS.
    pendingPoll: null,
    // Top liked flight-type posts, shown in the "人気のフライト" panel.
    popularFlights: [],
    // 日本語ニュース(APITube News API 経由、サーバー側でポーリング)。
    // 人気のフライトパネルの下部に表示する。新着はWebSocket
    // (news:new — handleWsMessageのケース参照)でリアルタイムに先頭へ
    // 追加される。
    news: [],
    // Feed pagination: whether an older page might still exist, and
    // whether a "load more" request is currently in flight (guards against
    // double-fetch from a fast double click).
    feedHasMore: true,
    feedLoadingMore: false,
    // Post search: null means "not searching, show the normal feed";
    // an array (even empty) means search results should be shown instead.
    // Kept entirely separate from state.posts so clearing the search
    // restores the normal feed exactly as it was (scroll position, loaded
    // pages, etc.) without needing to re-fetch it.
    searchQuery: "",
    searchResults: null,
    // Matching users for the same query, shown as a row above the post
    // results — same search box now covers both people and posts.
    userSearchResults: null,
    searching: false,
    // Which new posts should push-notify this user: "all" or "following".
    // Loaded from the server on boot; only meaningful once pushSubscribed
    // is true.
    notifyPref: "all",
    // Whether this browser currently has an active push subscription
    // registered with the server. Determined from the browser's own
    // PushManager state, not just a server flag.
    pushSubscribed: false,
    // ---- P2P地震情報 (P2PQuake) earthquake panel state ----
    // Whether the (independent, always-on) websocket to api.p2pquake.net
    // is currently connected.
    quakeWsConnected: false,
    // Whether the "テスト表示" button has opened a connection to
    // P2PQuake's public sandbox feed (wss://api-realtime-sandbox.p2pquake.net/v2/ws),
    // which periodically broadcasts simulated 551/556 messages for testing.
    // Separate from quakeWsConnected since the two sockets are independent.
    quakeTestMode: false,
    quakeTestConnecting: false,
    // Most recent JMA地震情報 (code 551 — a confirmed, already-happened
    // earthquake with hypocenter/points/magnitude) received, or a
    // sandbox-sourced test message (flagged via isTest — see handleQuakeMessage).
    latestQuake: null,
    // Most recent 緊急地震速報（警報）(code 556 — a forecast issued before
    // shaking arrives) received, real or sandbox-sourced.
    latestEEW: null,
    // ---- ランキング一覧（地震情報パネル下部のサイドバー） ----
    // 今月の飛行距離トップ5の簡易リスト（フル版はopenLeaderboardModal）。
    sidebarLeaderboard: [],
    // ---- OpenWeatherMap 天気検索 (地震情報パネル下部の検索窓) ----
    // 検索欄に入力中/確定したテキスト。パネルはquake系イベントのたびに
    // 再描画されるため、値をstateに保持して再描画後も入力内容が失われな
    // いようにする。
    weather: {
      query: "",
      loading: false,
      error: "",
      // ジオコーディングで複数地域がヒットした場合の選択肢(同名地域が
      // 複数国にまたがるケースがあるため)。1件だけヒットした場合は
      // 自動的に選択される。
      candidates: null,
      // 選択中の地域 { displayName, country, state, lat, lon }
      location: null,
      // /api/weather/summary のレスポンス(今日/明日のサマリーと
      // 詳細モーダル用の3時間ごとの予報を含む)
      data: null,
    },
    // ---- 気象庁 気象警報・注意報 (地震情報パネル下部) ----
    warningAlert: {
      areas: null, // GET /api/weather/warning-areas のプルダウン選択肢
      areasLoading: false,
      // 前回選んだ地域をlocalStorageから復元(未選択ならnull)。
      areaCode: localStorage.getItem(WARNING_AREA_KEY) || "",
      loading: false,
      error: "",
      data: null, // GET /api/weather/warnings のレスポンス
    },
    // Admin-configured ad embed (AdSense/AdMax/etc. snippet), loaded from
    // GET /api/ads on boot. `code` is only ever non-empty when `enabled`
    // is true (see routes/ads.js) and `frequency` is "insert after every
    // N posts" in the feed.
    adConfig: { enabled: false, code: "", frequency: 5 },
    // ---- 運営からのメッセージ(お知らせ)を見る「メッセージ」タブ ----
    // 画面上部に一瞬だけ出るバナー(showAnnouncementBar)とは別に、DM風の
    // 履歴として遡れるようにするための一覧。GET /api/notifications/
    // announcementsで初回ロードし、以後はWS(announcement:new)で先頭
    // (=一番新しい方、chatとしては末尾)に追記していく。
    messages: [],
    messagesLoaded: false,
  };

  // Page size for the main feed. Kept as a named constant since it's also
  // used to infer whether another (older) page likely exists: if a fetch
  // returns fewer than this many posts, we've reached the end of the feed.
  const FEED_PAGE_SIZE = 30;

  let ws = null;
  let wsRetryTimer = null;

  // Max number of images allowed on a single post (kept in sync with the
  // server-side limit in middleware/upload.js).
  const MAX_COMPOSER_IMAGES = 6;
  // Kept in sync with POLL_MIN_OPTIONS/POLL_MAX_OPTIONS/POLL_MAX_OPTION_LEN
  // in src/routes/posts.js — the server re-validates these regardless, but
  // matching limits here means the composer never lets you build something
  // the server would then reject.
  const POLL_MIN_OPTIONS = 2;
  const POLL_MAX_OPTIONS = 6;
  const POLL_MAX_OPTION_LEN = 60;
  // メモ(ニーボード)機能。src/routes/memos.jsのTITLE_MAX_LEN/TEXT_MAX_LENと
  // 揃えている(サーバー側も必ず再検証するが、フロントで先に弾ければ
  // 余計な往復を減らせる)。
  const MEMO_TITLE_MAX = 80;
  const MEMO_TEXT_MAX = 20000;

  // ---------------------------------------------------------------- utils
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // 文字列(ニュースの出典名など)から安定した色相(0-359)を作る軽量ハッシュ。
  // 画像の無いニュースカードのフォールバックアイコンに、出典ごとに違う
  // 色味を与えて単調にならないようにするためだけに使う。
  function hueFromString(str) {
    const s = String(str || "");
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    }
    return hash % 360;
  }

  // Turns URLs inside already-escaped HTML text into clickable links.
  // Must be called AFTER escapeHtml() so we're never injecting raw user input.
  function linkify(escapedText) {
    return escapedText.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (match) => {
      // Trim common trailing punctuation that isn't part of the URL.
      const trailing = match.match(/[.,:;!?)\]]+$/);
      const core = trailing ? match.slice(0, -trailing[0].length) : match;
      const rest = trailing ? trailing[0] : "";
      const href = core.startsWith("http") ? core : `https://${core}`;
      // class="auto-link": one shared style (see styles.css) for every link
      // linkify() produces, wherever it ends up (post text, comments, bio,
      // event descriptions, ...) instead of depending on each container to
      // remember to style its own <a> tags.
      return `<a class="auto-link" href="${href}" target="_blank" rel="noopener noreferrer">${core}</a>${rest}`;
    });
  }

  // Finds the first YouTube link in raw (unescaped) post text and returns
  // its 11-character video id, or null if there isn't one. Matches
  // youtube.com/watch?v=, youtube.com/shorts/, youtube.com/embed/,
  // youtube.com/live/ (the URL shape a channel's live-stream link uses),
  // and the youtu.be/ short form, with or without www./m. and http(s)://.
  function extractYouTubeId(rawText) {
    const re = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = String(rawText || "").match(re);
    return match ? match[1] : null;
  }

  // Lightweight "thumbnail first, iframe on click" card — matches the
  // click-to-view pattern already used for post images (openLightbox)
  // instead of auto-embedding a live player into every post in the feed.
  // Title/channel start as shimmering placeholders and are filled in by
  // loadYoutubeMeta() once the server-side oEmbed proxy responds.
  function youtubeCardHtml(videoId) {
    return `
      <div class="youtube-card" data-action="youtube-card" data-video-id="${videoId}">
        <div class="youtube-thumb-wrap">
          <img class="youtube-thumb" src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" loading="lazy" alt="YouTube動画のサムネイル" />
          <div class="youtube-scrim"></div>
          <div class="youtube-badge" data-role="yt-badge"><span class="yt-icon">▶</span>YouTube</div>
          <div class="youtube-play-btn">▶</div>
          <div class="youtube-card-meta">
            <div class="youtube-card-title is-loading" data-role="yt-title"></div>
            <div class="youtube-card-channel is-loading" data-role="yt-channel"></div>
          </div>
        </div>
      </div>
    `;
  }

  // Cache oEmbed results per video id for the lifetime of the page — once a
  // title/channel has been fetched, re-rendering the same post (e.g. after
  // a like) shouldn't re-request it.
  const youtubeMetaCache = new Map();

  // Fetches title/channel for a rendered card via the server-side oEmbed
  // proxy and fills them in, replacing the shimmering placeholders. Silently
  // leaves the placeholders hidden on failure (e.g. deleted/private video)
  // rather than showing an error inside the feed.
  async function loadYoutubeMeta(card) {
    const videoId = card.dataset.videoId;
    if (!videoId) return;
    const titleEl = card.querySelector('[data-role="yt-title"]');
    const channelEl = card.querySelector('[data-role="yt-channel"]');
    if (!titleEl || !channelEl) return;

    const applyMeta = (meta) => {
      if (meta && meta.title) {
        titleEl.textContent = meta.title;
        titleEl.classList.remove("is-loading");
      } else {
        titleEl.remove();
      }
      if (meta && meta.authorName) {
        channelEl.textContent = meta.authorName;
        channelEl.classList.remove("is-loading");
      } else {
        channelEl.remove();
      }
      // `live` is only populated when the server has YOUTUBE_API_KEY
      // configured (see routes/youtube.js) — without it the badge just
      // stays the normal "YouTube" badge.
      const badgeEl = card.querySelector('[data-role="yt-badge"]');
      if (badgeEl && meta && meta.live === "live") {
        badgeEl.classList.add("youtube-badge-live");
        badgeEl.innerHTML = `<span class="yt-live-dot"></span>LIVE`;
      } else if (badgeEl && meta && meta.live === "upcoming") {
        badgeEl.innerHTML = `<span class="yt-icon">▶</span>配信予定`;
      }
    };

    if (youtubeMetaCache.has(videoId)) {
      applyMeta(youtubeMetaCache.get(videoId));
      return;
    }
    try {
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const meta = await api(`/api/youtube/oembed?url=${encodeURIComponent(videoUrl)}`);
      youtubeMetaCache.set(videoId, meta);
      applyMeta(meta);
    } catch {
      youtubeMetaCache.set(videoId, null);
      applyMeta(null);
    }
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "たった今";
    if (diffMin < 60) return `${diffMin}分前`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}時間前`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}日前`;
    return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  }

  // Full date+time for event start/end times (unlike fmtTime above, this
  // is always the absolute date — a relative "3日前" reading doesn't make
  // sense for a future event's start time).
  function fmtEventDateTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString("ja-JP", {
      year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in *local* time
  // (no timezone/offset) — toISOString() is UTC, so build it from the
  // Date object's local getters instead.
  function toDateTimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function avatarHtml(user, size) {
    const style = size ? `width:${size}px;height:${size}px;` : "";
    if (user.avatarUrl) {
      return `<img class="avatar" style="${style}" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name || user.callsign || "")}" />`;
    }
    const hue = Number.isFinite(user.hue) ? user.hue : 200;
    const initial = (user.name || user.callsign || "?").trim().charAt(0).toUpperCase();
    return `<div class="avatar avatar-fallback" style="${style}background:hsl(${hue} 70% 55%)">${escapeHtml(initial)}</div>`;
  }

  // Renders the inner content of a flight card from a flight object (either
  // a pending SimBrief import or a post's saved `flight` field). Every field
  // is optional since SimBrief's JSON shape/coverage varies by account and
  // aircraft, so each line only appears when the data is actually present.
  function flightCardHtml(f) {
    const hasRoute = f.originIcao || f.destIcao;
    const subtitle = [f.originName, f.destName].filter(Boolean).map(escapeHtml).join("  →  ");

    const badges = [];
    if (f.callsign) badges.push(`<span class="flight-badge">📻 ${escapeHtml(f.callsign)}</span>`);
    if (f.aircraftName || f.aircraftIcao) badges.push(`<span class="flight-badge">🛩️ ${escapeHtml(f.aircraftName || f.aircraftIcao)}</span>`);
    if (typeof f.route === "string" && f.route) badges.push(`<span class="flight-badge" title="${escapeHtml(f.route)}">🗺️ ${escapeHtml(f.route)}</span>`);

    const stats = [];
    if (f.durMin != null) stats.push(`<div class="stat"><b>${Math.round(f.durMin)}分</b>飛行時間</div>`);
    if (f.distance != null) stats.push(`<div class="stat"><b>${f.distance}nm</b>距離</div>`);
    if (f.cruiseAlt != null) stats.push(`<div class="stat"><b>FL${Math.round(f.cruiseAlt / 100)}</b>巡航高度</div>`);
    if (f.eta) {
      const etaDate = new Date(f.eta);
      if (!Number.isNaN(etaDate.getTime())) {
        const etaStr = etaDate.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        stats.push(`<div class="stat"><b>${etaStr}</b>到着予定</div>`);
      }
    }

    return `
      ${hasRoute ? `<div class="flight-route-row"><b>${escapeHtml(f.originIcao || "?")}</b><span class="flight-arrow">→</span><b>${escapeHtml(f.destIcao || "?")}</b></div>` : ""}
      ${subtitle ? `<div class="flight-subtitle">${subtitle}</div>` : ""}
      ${badges.length ? `<div class="flight-badges">${badges.join("")}</div>` : ""}
      ${stats.length ? `<div class="flight-stats">${stats.join("")}</div>` : ""}
    `;
  }

  // Builds a permalink for a post and shares it via the OS share sheet
  // (mobile browsers) or copies it to the clipboard (desktop / unsupported
  // browsers). Loading a URL with ?post=<id> is handled in boot()/openSharedPostFromUrl().
  async function sharePost(post) {
    const url = `${location.origin}${location.pathname}?post=${encodeURIComponent(post.id)}`;
    const shareText = post.text ? post.text.slice(0, 100) : `${post.authorName}さんの投稿`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "AeroSocial", text: shareText, url });
      } catch (err) {
        // AbortError: the user closed the share sheet without picking
        // anything — not a failure, so don't show an error toast for it.
        if (err && err.name !== "AbortError") toast("共有に失敗しました。");
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      toast("リンクをコピーしました");
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS context) — fall back to
      // a manual copy via a prompt so the user can still grab the link.
      window.prompt("このリンクをコピーしてください:", url);
    }
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------------------------------------------------------------- API
  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (!(options.body instanceof FormData) && options.body) {
      headers["Content-Type"] = "application/json";
    }
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { /* empty body, e.g. 204 */ }
    if (!res.ok) {
      const message = (data && data.error) || `エラーが発生しました (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  function setToken(token) {
    state.token = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  // ---------------------------------------------------------------- push notifications
  // PushManager wants the VAPID public key as a Uint8Array, but the server
  // hands it over as a URL-safe base64 string.
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  let vapidPublicKey = null;
  // Guards watchForServiceWorkerUpdates() below so its listeners are only
  // ever wired up once, even though getServiceWorkerRegistration() itself
  // is called from several places (push setup, boot, ...).
  let swUpdateWatchStarted = false;

  async function getServiceWorkerRegistration() {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.register("/sw.js");
    watchForServiceWorkerUpdates(reg);
    return reg;
  }

  // Makes a server-side deploy actually reach people without them needing
  // to force-reload — which mobile browsers don't offer an easy gesture
  // for anyway. sw.js's fetch handler is network-first now, so a plain
  // reload already picks up new app.js/styles.css; this handles the part
  // that still needs it: getting that reload to happen automatically.
  //
  //   1) Ask the browser to re-check /sw.js for changes whenever the tab
  //      becomes visible, instead of waiting on its own update schedule
  //      (which can be up to ~24h on some browsers).
  //   2) sw.js calls self.skipWaiting() + self.clients.claim(), so once a
  //      newly-fetched sw.js is byte-different from the running one, it
  //      installs and activates immediately rather than waiting for every
  //      tab to close first. That activation fires "controllerchange" in
  //      every currently-open tab — reload once when that happens so this
  //      tab's already-loaded (and now stale) app.js/styles.css actually
  //      gets replaced, instead of the old JS just continuing to run.
  function watchForServiceWorkerUpdates(reg) {
    if (!reg || swUpdateWatchStarted) return;
    swUpdateWatchStarted = true;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      toast("新しいバージョンに更新します…");
      setTimeout(() => window.location.reload(), 600);
    });
  }

  async function getCurrentPushSubscription() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  // Requests notification permission and subscribes this browser to push,
  // registering the subscription with the server. Returns true on success;
  // surfaces a toast and returns false on any failure (denied permission,
  // unsupported browser, server has no VAPID keys configured, ...) rather
  // than throwing, since this is always driven from a settings toggle.
  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast("このブラウザはプッシュ通知に対応していません");
      return false;
    }
    try {
      if (!vapidPublicKey) {
        const { key } = await api("/api/notifications/vapid-public-key");
        vapidPublicKey = key;
      }
      if (!vapidPublicKey) {
        toast("プッシュ通知はサーバー側で未設定です");
        return false;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast("通知が許可されませんでした");
        return false;
      }

      const reg = await getServiceWorkerRegistration();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      }

      await api("/api/notifications/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      state.pushSubscribed = true;
      return true;
    } catch (err) {
      console.error(err);
      toast("プッシュ通知の設定に失敗しました");
      return false;
    }
  }

  async function disablePush() {
    try {
      const sub = await getCurrentPushSubscription();
      if (sub) {
        await api("/api/notifications/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error(err);
    } finally {
      state.pushSubscribed = false;
    }
  }

  // Loads the saved postNotify preference and checks whether this browser
  // already has an active push subscription. Best-effort: failures here
  // shouldn't block the rest of boot().
  async function loadNotificationSettings() {
    try {
      const { postNotify } = await api("/api/notifications/settings");
      state.notifyPref = postNotify;
    } catch {
      /* not critical */
    }
    try {
      await getServiceWorkerRegistration();
      const sub = await getCurrentPushSubscription();
      state.pushSubscribed = !!sub;
    } catch {
      /* not critical */
    }
  }

  // Picks up the id_token handed back by GET /api/auth/google/callback (the
  // redirect-based fallback flow — see routes/auth.js) via the URL
  // fragment, then feeds it into the exact same handler the GSI
  // button/One Tap flow uses, so account linking / needsCallsign behaves
  // identically either way. Also surfaces ?googleError=... from a failed
  // or cancelled redirect attempt. Both are stripped from the URL after
  // being read so a page refresh doesn't replay them.
  function consumeGoogleRedirectResult() {
    const hashMatch = location.hash.match(/(?:^#|&)google=([^&]+)/);
    if (hashMatch) {
      const credential = decodeURIComponent(hashMatch[1]);
      history.replaceState(null, "", location.pathname + location.search);
      handleGoogleCredential({ credential });
      return true;
    }
    const params = new URLSearchParams(location.search);
    const googleError = params.get("googleError");
    if (googleError) {
      // Not handled directly (unlike the credential case above) — leave it
      // for the normal boot() flow below to render(), so the auth screen
      // picks up state.error the same way a failed button-flow login does.
      state.error = googleError;
      params.delete("googleError");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    }
    return false;
  }

  // ---------------------------------------------------------------- data actions
  // Confirms whether the current user has admin rights by pinging an
  // admin-only route. GET /api/admin/me is the cheapest one — it's gated
  // by the same requireAuth+requireAdmin chain as every other /api/admin/*
  // route, so a 200 here is a reliable signal the admin panel button (and
  // its routes) will actually work for this user; anything else (403, 401,
  // network error) just hides the button.
  async function checkAdminStatus() {
    if (!state.user) { state.isAdmin = false; return; }
    try {
      await api("/api/admin/me");
      state.isAdmin = true;
    } catch {
      state.isAdmin = false;
    }
  }

  // ---------------------------------------------------------------- pull-to-refresh
  // Manual pull-to-refresh for the feed. Chrome/Safari only offer their
  // native version of this inside a normal browser tab — an installed PWA
  // (Add to Home Screen) gets nothing, so this reimplements the gesture:
  // pulling down while already scrolled to the very top of the page
  // reloads the feed from scratch.
  let ptrStartY = null;
  let ptrPulling = false;
  let ptrRefreshing = false;
  const PTR_THRESHOLD = 70; // px pulled before release triggers a refresh
  const PTR_MAX = 110; // px of visual travel, after damping, before it caps

  // Only track the gesture on the main feed screen, only when the page
  // isn't scrolled down already, and never while a modal is open (a
  // downward drag inside a modal is for that modal, not for refreshing the
  // feed underneath it).
  function ptrShouldTrack() {
    if (ptrRefreshing) return false;
    if (!document.getElementById("feed-list")) return false;
    if (document.querySelector(".modal-backdrop")) return false;
    if ((window.scrollY || document.documentElement.scrollTop) > 0) return false;
    return true;
  }

  function setPtrIndicator(pulledPx, { animate = false, armed = false, spinning = false } = {}) {
    const indicator = document.getElementById("ptr-indicator");
    if (!indicator) return;
    indicator.style.transition = animate ? "transform 0.2s ease, opacity 0.15s ease" : "none";
    indicator.style.transform = `translate(-50%, ${pulledPx - 60}px)`;
    indicator.style.opacity = String(Math.min(1, pulledPx / PTR_THRESHOLD));
    indicator.classList.toggle("ptr-armed", armed);
    indicator.classList.toggle("ptr-spinning", spinning);
    const icon = document.getElementById("ptr-icon");
    if (icon) icon.style.transform = `rotate(${Math.min(180, (pulledPx / PTR_THRESHOLD) * 180)}deg)`;
  }

  function resetPtrIndicator() {
    setPtrIndicator(0, { animate: true });
  }

  function setupPullToRefresh() {
    window.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || !ptrShouldTrack()) {
        ptrStartY = null;
        return;
      }
      ptrStartY = e.touches[0].clientY;
      ptrPulling = false;
    }, { passive: true });

    window.addEventListener("touchmove", (e) => {
      if (ptrStartY == null || ptrRefreshing) return;
      const delta = e.touches[0].clientY - ptrStartY;
      if (delta <= 0 || (window.scrollY || document.documentElement.scrollTop) > 0) {
        // Not actually pulling down from the top (anymore) — likely just
        // normal scrolling, so back off and let it happen undisturbed.
        if (ptrPulling) resetPtrIndicator();
        ptrPulling = false;
        return;
      }
      ptrPulling = true;
      const pulled = Math.min(PTR_MAX, delta * 0.5); // damped, like native gestures
      setPtrIndicator(pulled, { armed: pulled >= PTR_THRESHOLD });
    }, { passive: true });

    window.addEventListener("touchend", async () => {
      if (!ptrPulling) { ptrStartY = null; return; }
      const armed = document.getElementById("ptr-indicator")?.classList.contains("ptr-armed");
      ptrStartY = null;
      ptrPulling = false;
      if (!armed) { resetPtrIndicator(); return; }

      ptrRefreshing = true;
      setPtrIndicator(PTR_THRESHOLD, { animate: true, armed: true, spinning: true });
      try {
        await loadFeed();
      } finally {
        ptrRefreshing = false;
        resetPtrIndicator();
      }
    });
  }

  async function boot() {
    // Installed PWAs get no native pull-to-refresh gesture (only a regular
    // browser tab offers that), so it's implemented by hand — set up once
    // here; it re-queries #ptr-indicator/#feed-list on every touch, so it
    // keeps working across every renderMainScreen() re-render.
    setupPullToRefresh();
    // Registered unconditionally (not just when the user opts into push)
    // so the app is installable as a PWA even if notifications are never
    // turned on. Fire-and-forget: nothing else in boot should wait on it.
    getServiceWorkerRegistration().catch(() => {});
    if (consumeGoogleRedirectResult()) {
      // A successful Google redirect (credential in the hash) takes over
      // entirely — handleGoogleCredential() renders and loads the feed
      // itself once done, so skip the normal boot flow below.
      state.booted = true;
      return;
    }
    if (state.token) {
      try {
        const { user } = await api("/api/users/me");
        state.user = user;
      } catch {
        setToken(null);
        state.user = null;
      }
    }
    if (state.user) await checkAdminStatus();
    if (state.user) syncWarningAreaSubscription();
    state.booted = true;
    render();
    if (state.user) {
      await loadAdConfig();
      await loadFeed();
      loadPopularFlights();
      openSharedPostFromUrl();
      loadNotificationSettings();
      loadMessages();
    }
    connectWS();
    connectQuakeWS();
    startQuakePolling();
    // quakeパネルと同じく未ログインでも見せるので、ログイン分岐の外側で
    // 呼ぶ。以降の新着はWS(news:new)でリアルタイムに追加される。
    loadNews();
    // ランキングパネルも同様に未ログインでも見せる(quake/newsパネルと
    // 同方針)。フライト実績の変動はイベントほど頻繁でもリアルタイム性が
    // 重要でもないので、WS購読はせず起動時に一度だけ取得する。
    loadSidebarLeaderboard();
  }

  // If the page was opened via a shared post link (?post=<id>), open that
  // post's detail view. The post may be older than the feed's first page,
  // so it's fetched individually (GET /api/posts/:id) when not already
  // loaded, then merged into state.posts so likes/comments work normally.
  async function openSharedPostFromUrl() {
    const postId = new URLSearchParams(location.search).get("post");
    if (!postId) return;
    if (!state.posts.some((p) => p.id === postId)) {
      try {
        const { post } = await api(`/api/posts/${encodeURIComponent(postId)}`);
        state.posts.push(post);
      } catch {
        toast("共有された投稿が見つかりませんでした。");
        return;
      }
    }
    openPostDetail(postId);
  }

  async function loadFeed() {
    try {
      const { posts } = await api(`/api/posts?limit=${FEED_PAGE_SIZE}`);
      state.posts = posts;
      state.feedHasMore = posts.length >= FEED_PAGE_SIZE;
      renderFeedList();
    } catch (err) {
      toast(err.message);
    }
  }

  // GET /api/ads is public (no auth), but this only ever needs to run once
  // the feed is about to be shown, so it's kicked off alongside loadFeed()
  // in boot() rather than unconditionally for every visit. A failure here
  // just means no ads render — never surfaced to the user.
  async function loadAdConfig() {
    try {
      state.adConfig = await api("/api/ads");
    } catch {
      state.adConfig = { enabled: false, code: "", frequency: 5 };
    }
  }

  // Fetches the next (older) page of posts, using the last currently-loaded
  // post's timestamp as the cursor (server-side: `WHERE created_at < before`).
  // Without this, only the most recent FEED_PAGE_SIZE posts were ever
  // reachable and everything older effectively disappeared from the feed.
  async function loadMoreFeed() {
    if (state.feedLoadingMore || !state.feedHasMore || !state.posts.length) return;
    state.feedLoadingMore = true;
    renderFeedList();
    try {
      const oldest = state.posts[state.posts.length - 1];
      const { posts } = await api(
        `/api/posts?limit=${FEED_PAGE_SIZE}&before=${encodeURIComponent(oldest.createdAt)}`
      );
      const existingIds = new Set(state.posts.map((p) => p.id));
      const fresh = posts.filter((p) => !existingIds.has(p.id));
      state.posts = [...state.posts, ...fresh];
      state.feedHasMore = posts.length >= FEED_PAGE_SIZE;
    } catch (err) {
      toast(err.message);
    } finally {
      state.feedLoadingMore = false;
      renderFeedList();
    }
  }

  // Searches both users (by callsign/name) and post text (and, server-side,
  // flight routes/airports) for the same query. Results replace the feed
  // list entirely while a query is active; state.posts / pagination are
  // left untouched so clearing the search restores the feed exactly as it
  // was. The two lookups are independent — if one endpoint fails, the
  // other's results still show rather than losing both.
  async function runFeedSearch(query) {
    const trimmed = query.trim();
    if (!trimmed) {
      clearFeedSearch();
      return;
    }
    state.searchQuery = trimmed;
    state.searching = true;
    renderFeedList();

    const [postsResult, usersResult] = await Promise.allSettled([
      api(`/api/posts/search?q=${encodeURIComponent(trimmed)}`),
      api(`/api/users/search?q=${encodeURIComponent(trimmed)}`),
    ]);

    state.searchResults = postsResult.status === "fulfilled" ? postsResult.value.posts : [];
    state.userSearchResults = usersResult.status === "fulfilled" ? usersResult.value.users : [];
    if (postsResult.status === "rejected") toast(postsResult.reason.message);
    if (usersResult.status === "rejected") toast(usersResult.reason.message);

    state.searching = false;
    renderFeedList();
  }

  function clearFeedSearch() {
    state.searchQuery = "";
    state.searchResults = null;
    state.userSearchResults = null;
    state.searching = false;
    renderFeedList();
  }

  async function loadPopularFlights() {
    try {
      const { posts } = await api("/api/posts/popular-flights?limit=5");
      state.popularFlights = posts;
      renderPopularFlights();
    } catch {
      // Non-critical panel — fail silently rather than toasting an error
      // over what is essentially a "nice to have" sidebar.
    }
  }

  // ニュースパネルの初期ロード。未ログインの訪問者にも見せる(quakeパネル
  // と同方針)ので、ログイン状態に関わらずboot()から呼ぶ。以降の新着は
  // WebSocketのnews:newで追加される(handleWsMessage参照) — ここでの
  // 再フェッチはページ読み込み時と、WS再接続直後に取りこぼしを埋める
  // 目的の2回だけで十分。
  async function loadNews() {
    try {
      const { items } = await api("/api/news?limit=60");
      state.news = items;
      renderNewsPanel();
      renderNewsHubTabs();
      renderNewsHubBody();
    } catch {
      // Non-critical panel — fail silently, same reasoning as popular flights.
    }
  }

  // ---------------------------------------------------------------- 運営からのメッセージ(「メッセージ」タブ)
  // GET /api/notifications/announcements の履歴を取得し、chatの表示順
  // (古い→新しい)に並べ替えて保持する。バナー(showAnnouncementBar)は
  // 別枠で既存のまま動き続け、こちらはその履歴を後から遡れるようにする。
  async function loadMessages() {
    try {
      const { announcements } = await api("/api/notifications/announcements?limit=100");
      state.messages = announcements.slice().reverse();
      state.messagesLoaded = true;
      renderMessagesBadge();
      renderMessagesList();
    } catch {
      // お知らせが無い/失敗してもアプリ全体は困らないので静かに諦める。
    }
  }

  function messagesLastSeenKey() {
    return state.user ? `${MESSAGES_LAST_SEEN_KEY_PREFIX}${state.user.id}` : null;
  }

  function hasUnreadMessages() {
    if (!state.messages.length) return false;
    const key = messagesLastSeenKey();
    if (!key) return false;
    const lastSeenId = localStorage.getItem(key);
    const newestId = state.messages[state.messages.length - 1].id;
    return lastSeenId !== newestId;
  }

  function markMessagesRead() {
    const key = messagesLastSeenKey();
    if (!key || !state.messages.length) return;
    localStorage.setItem(key, state.messages[state.messages.length - 1].id);
    renderMessagesBadge();
  }

  // トップバー/モバイルメニューの「メッセージ」ボタンに未読バッジを
  // 反映する。両方存在するとは限らない(トップバーは900px未満で非表示、
  // モバイルメニューはシートを開いている時だけDOMにある)ので、それぞれ
  // 要素があるかを見てから触る。
  function renderMessagesBadge() {
    const unread = hasUnreadMessages();
    document.querySelectorAll(".messages-btn").forEach((el) => {
      el.classList.toggle("has-badge", unread);
    });
  }

  async function login(callsign, password) {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ callsign, password }) });
    setToken(data.token);
    state.user = data.user;
  }

  // ---------------------------------------------------------------- Google sign-in
  // Google sign-in now goes exclusively through the redirect-based OAuth
  // flow (GET /api/auth/google/start -> Google's hosted consent screen ->
  // GET /api/auth/google/callback -> back here with the id_token in the
  // URL hash, picked up by consumeGoogleRedirectResult() below). The GSI
  // button/One Tap widget was removed: it depends on the browser-side
  // "Authorized JavaScript origins" check, which was returning a 400 here.

  // Called with { credential: <ID token> } once Google's redirect flow
  // hands back an id_token (see consumeGoogleRedirectResult() below).
  // Existing Google-linked users log straight in; brand-new ones are
  // prompted to choose their own callsign first.
  async function handleGoogleCredential(response) {
    state.error = "";
    try {
      const data = await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential }) });
      if (data.needsCallsign) {
        openGoogleCallsignModal(response.credential, data.suggestedCallsign);
        return;
      }
      setToken(data.token);
      state.user = data.user;
      await checkAdminStatus();
      render();
      await loadFeed();
      loadPopularFlights();
      connectWS();
    } catch (err) {
      state.error = err.message;
      renderAuthScreen();
    }
  }

  // Small modal shown once for brand-new Google sign-ups so the user can
  // pick their own callsign instead of having one generated for them.
  function openGoogleCallsignModal(credential, suggestedCallsign) {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal">
        <h2>コールサインを選択</h2>
        <p class="sub" style="margin:-8px 0 16px; color:var(--text-dim); font-size:13px;">
          Googleアカウントでのアカウント作成まであと一歩です。使用するコールサインを入力してください。
        </p>
        <form id="google-callsign-form">
          <div class="field">
            <label>コールサイン</label>
            <input name="callsign" placeholder="例: SKYHAWK1" value="${escapeHtml(suggestedCallsign || "")}" autocomplete="off" required />
          </div>
          <div class="field">
            <label>拠点空港コード (任意)</label>
            <input name="homeBase" placeholder="例: RJTT" maxlength="4" />
          </div>
          ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
          <div style="display:flex; gap:10px; margin-top: 6px;">
            <button type="submit" class="btn btn-primary" id="google-callsign-submit" style="flex:1">アカウント作成</button>
            <button type="button" class="btn btn-ghost" id="google-callsign-cancel">キャンセル</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById("google-callsign-cancel").addEventListener("click", () => overlay.remove());

    document.getElementById("google-callsign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = document.getElementById("google-callsign-submit");
      submitBtn.disabled = true;
      state.error = "";
      try {
        const data = await api("/api/auth/google", {
          method: "POST",
          body: JSON.stringify({ credential, callsign: fd.get("callsign"), homeBase: fd.get("homeBase") }),
        });
        setToken(data.token);
        state.user = data.user;
        await checkAdminStatus();
        overlay.remove();
        render();
        await loadFeed();
        loadPopularFlights();
        connectWS();
      } catch (err) {
        state.error = err.message;
        overlay.remove();
        openGoogleCallsignModal(credential, fd.get("callsign"));
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  function logout() {
    setToken(null);
    state.user = null;
    state.isAdmin = false;
    state.posts = [];
    if (ws) ws.close();
    render();
  }

  async function createPost(text, files, flight, poll) {
    const form = new FormData();
    if (text) form.append("text", text);
    (files || []).forEach((file) => form.append("images", file));
    if (flight) form.append("flight", JSON.stringify(flight));
    if (poll) form.append("poll", JSON.stringify(poll));
    const { post } = await api("/api/posts", { method: "POST", body: form });
    state.posts = [post, ...state.posts.filter((p) => p.id !== post.id)];
    renderFeedList();
    if (post.type === "flight") loadPopularFlights();
  }

  async function deletePost(id) {
    if (!confirm("この投稿を削除しますか？")) return;
    await api(`/api/posts/${id}`, { method: "DELETE" });
    state.posts = state.posts.filter((p) => p.id !== id);
    renderFeedList();
  }

  async function toggleLike(id) {
    const post = state.posts.find((p) => p.id === id);
    if (!post) return;
    // optimistic update
    const prevLiked = post.likedByMe;
    const prevCount = post.likeCount;
    post.likedByMe = !prevLiked;
    post.likeCount = prevCount + (post.likedByMe ? 1 : -1);
    renderFeedList();
    try {
      const { liked, likeCount } = await api(`/api/posts/${id}/like`, { method: "POST" });
      post.likedByMe = liked;
      post.likeCount = likeCount;
      renderFeedList();
      if (post.type === "flight") loadPopularFlights();
    } catch (err) {
      post.likedByMe = prevLiked;
      post.likeCount = prevCount;
      renderFeedList();
      toast(err.message);
    }
  }

  async function voteOnPoll(postId, optionId) {
    const post = state.posts.find((p) => p.id === postId);
    if (!post || !post.poll) return;
    // optimistic update — mirrors toggleLike()'s pattern above
    const prevPoll = JSON.parse(JSON.stringify(post.poll));
    const wasMine = post.poll.myVoteOptionId === optionId;
    post.poll.options.forEach((opt) => {
      if (opt.id === prevPoll.myVoteOptionId) opt.voteCount -= 1;
      if (opt.id === optionId && !wasMine) opt.voteCount += 1;
    });
    post.poll.myVoteOptionId = wasMine ? null : optionId;
    post.poll.totalVotes = prevPoll.totalVotes + (wasMine ? -1 : (prevPoll.myVoteOptionId ? 0 : 1));
    renderFeedList();
    try {
      const { poll } = await api(`/api/posts/${postId}/vote`, {
        method: "POST",
        body: JSON.stringify({ optionId }),
      });
      // Server response omits myVoteOptionId is never true here — this is
      // the direct REST response to *this* request, not a WS broadcast
      // (see handleWsMessage's "poll:vote" case below for why that one
      // deliberately doesn't carry myVoteOptionId).
      post.poll = poll;
      renderFeedList();
    } catch (err) {
      post.poll = prevPoll;
      renderFeedList();
      toast(err.message);
    }
  }

  // Minimum time (ms) a comment form stays disabled after a successful
  // submit, to stop the same person from firing off several comments on
  // the same post in quick succession.
  const COMMENT_COOLDOWN_MS = 2000;

  async function loadComments(postId) {
    try {
      const { comments } = await api(`/api/posts/${postId}/comments`);
      state.commentsByPost[postId] = comments;
      renderFeedList();
    } catch (err) {
      toast(err.message);
    }
  }

  async function postComment(postId, text) {
    if (!text.trim()) return;
    const { comment } = await api(`/api/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    // The server broadcasts "comment:new" to every connected client,
    // including the author's own socket. That broadcast can (and often
    // does, since it's sent before the HTTP response) reach us via
    // handleWsMessage before this POST's response resolves — if that
    // happened, the comment is already in the list, so skip re-adding it
    // (and re-incrementing commentCount) here.
    const list = state.commentsByPost[postId] || [];
    if (!list.some((c) => c.id === comment.id)) {
      state.commentsByPost[postId] = [...list, comment];
      const post = state.posts.find((p) => p.id === postId);
      if (post) post.commentCount += 1;
    }
    renderFeedList();
  }

  async function updateProfile({ name, bio, homeBase, favoriteAnimeList, avatarFile }) {
    const form = new FormData();
    if (name !== undefined) form.append("name", name);
    if (bio !== undefined) form.append("bio", bio);
    if (homeBase !== undefined) form.append("homeBase", homeBase);
    if (favoriteAnimeList !== undefined) form.append("favoriteAnimeList", JSON.stringify(favoriteAnimeList));
    if (avatarFile) form.append("avatar", avatarFile);
    const { user } = await api("/api/users/me", { method: "PATCH", body: form });
    state.user = user;
    state.posts.forEach((p) => {
      if (p.authorId === user.id) {
        p.authorName = user.name;
        p.authorAvatarUrl = user.avatarUrl;
      }
    });
  }

  // ---------------------------------------------------------------- WebSocket
  function connectWS() {
    // Previously returned early when logged out, since nothing consumed
    // the broadcasts yet for an anonymous visitor (state.posts stays empty
    // until loadFeed(), which only runs when logged in). Now that the news
    // panel (news:new — see handleWsMessage) is shown to every visitor
    // regardless of login, this connects unconditionally so logged-out
    // users get live news too; the backend already accepted anonymous
    // connections for this reason (see ws.js's comment on initWebSocket).
    // Guard against ending up with two live sockets (e.g. connectWS() being
    // reachable from more than one auth flow in the same session) — an
    // orphaned old socket would still fire onmessage for every broadcast,
    // so anything relying on it being called at most once per message
    // (like commentCount += 1 below) could silently double-apply.
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close();
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws${state.token ? `?token=${encodeURIComponent(state.token)}` : ""}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      state.wsConnected = true;
      updateWsIndicator();
      if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      updateWsIndicator();
      // Always retry now (see the connectWS() comment above) — previously
      // gated on state.user since a logged-out socket had nothing to do.
      wsRetryTimer = setTimeout(connectWS, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleWsMessage(msg);
    };
  }

  function updateWsIndicator() {
    const dot = document.getElementById("ws-dot");
    if (!dot) return;
    dot.classList.toggle("live", state.wsConnected);
  }

  function handleWsMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "post:new": {
        if (!state.posts.some((p) => p.id === msg.payload.id)) {
          state.posts = [msg.payload, ...state.posts];
          renderFeedList();
          if (msg.payload.type === "flight") loadPopularFlights();
        }
        break;
      }
      case "post:deleted": {
        state.posts = state.posts.filter((p) => p.id !== msg.payload.id);
        renderFeedList();
        break;
      }
      case "post:like": {
        const post = state.posts.find((p) => p.id === msg.payload.postId);
        if (post) {
          post.likeCount = msg.payload.likeCount;
          if (state.user && msg.payload.userId === state.user.id) post.likedByMe = msg.payload.liked;
          renderFeedList();
          if (post.type === "flight") loadPopularFlights();
        }
        break;
      }
      case "poll:vote": {
        // Broadcast payload deliberately omits myVoteOptionId (it's
        // per-viewer, not a shared fact — see routes/posts.js's /vote
        // handler), so only counts/totalVotes are applied here; the
        // voter's own myVoteOptionId is set directly by voteOnPoll()'s
        // REST response instead, and this WS echo must not stomp on it.
        const post = state.posts.find((p) => p.id === msg.payload.postId);
        if (post && post.poll) {
          const myVoteOptionId = post.poll.myVoteOptionId;
          post.poll = { ...msg.payload.poll, myVoteOptionId };
          renderFeedList();
        }
        break;
      }
      case "comment:new": {
        const post = state.posts.find((p) => p.id === msg.payload.postId);
        if (post) {
          // Only touch the full comment list while the comments panel for
          // this post is expanded (same as before) — but also use it,
          // when available, to detect a comment we already applied
          // ourselves via postComment()'s REST response, so it isn't
          // double-counted/double-appended when its WS echo arrives too.
          const list = state.openComments.has(post.id) ? (state.commentsByPost[post.id] || []) : null;
          const alreadyKnown = !!list && list.some((c) => c.id === msg.payload.comment.id);
          if (!alreadyKnown) {
            post.commentCount += 1;
            if (list) {
              state.commentsByPost[post.id] = [...list, msg.payload.comment];
            }
            renderFeedList();
          }
        }
        break;
      }
      case "news:new": {
        // src/services/newsFeed.js broadcasts one message per new article,
        // oldest-first, as soon as it's detected — see that file for why
        // this is a server-side poll-then-broadcast instead of the
        // browser talking to APITube directly.
        if (!state.news.some((n) => n.id === msg.payload.id)) {
          state.news = [msg.payload, ...state.news].slice(0, 90);
          renderNewsPanel();
          renderNewsHubTabs();
          renderNewsHubBody();
          if (msg.payload.isBreaking) showNewsFlashPopup(msg.payload);
        }
        break;
      }
      // event:created/updated/deleted/participants: これらは元々
      // サイドバーのイベント一覧(WS更新のたびに再取得)を最新に保つ
      // ためだけの購読だった。そのサイドバーはランキング表示に置き換えた
      // (イベント作成/参加自体はopenEventsModal側でAPIから都度取得する
      // だけで、開いている間のリアルタイム更新はもともと無い)ため、
      // 対応するcaseは不要になり削除した。
      case "announcement:new": {
        showAnnouncementBar(msg.payload);
        // 「メッセージ」タブの履歴にも同じものを反映する。バナーを閉じても
        // 後から見返せるのがこのタブの役目なので、ここでも必ず追記する。
        if (!state.messages.some((m) => m.id === msg.payload.id)) {
          state.messages = [...state.messages, msg.payload];
          if (messagesModalEl) {
            // 開いている間に届いた分は「見た」扱いにして、既読位置も
            // 一緒に進める(未読バッジが閉じた瞬間に点灯し直すのを防ぐ)。
            renderMessagesList();
            markMessagesRead();
          } else {
            renderMessagesBadge();
          }
        }
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- P2P地震情報 (earthquake panel)
  // Independent of the app's own auth/WS connection above: this is a
  // public, unauthenticated feed (no API key, no login required), so it
  // connects as soon as the page loads and stays connected regardless of
  // whether the user is signed in — it just has nowhere to render until
  // renderMainScreen() (and its #quake-slot) exists.
  // Spec: https://www.p2pquake.net/develop/json_api_v2/
  const QUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";
  let quakeWs = null;
  let quakeWsRetryTimer = null;
  // モバイルの地震情報タブに未確認バッジを出すためのフラグ。
  // markQuakeUnseen() / updateQuakeTabBadge() 参照。
  let quakeUnseen = false;
  let quakeMapInstance = null;
  // Debounce timer for the weather search box mounted at the bottom of the
  // quake panel (see wireWeatherSection) — same 500ms-ish convention as
  // feedSearchTimer, just declared at module scope since the panel (and
  // therefore the input element) gets torn down and recreated on every
  // renderQuakePanel() call.
  let weatherSearchTimer = null;

  // P2PQuake encodes JMA震度 as the real value × 10, with the "弱/強" splits
  // of 5 and 6 getting their own in-between codes (45/50/55/60) instead of
  // a fraction. -1 means "unknown" (used for older/incomplete reports).
  const SCALE_LABELS = { "-1": "不明", 10: "1", 20: "2", 30: "3", 40: "4", 45: "5弱", 50: "5強", 55: "6弱", 60: "6強", 70: "7", 99: "7以上" };
  function scaleLabel(scale) {
    if (scale == null) return "不明";
    return SCALE_LABELS[scale] ?? String(scale);
  }

  const TSUNAMI_LABELS = {
    None: "なし", Unknown: "不明", Checking: "調査中",
    NonEffective: "若干の海面変動の可能性（被害の心配なし）",
    Watch: "津波注意報発表中", Warning: "津波警報等発表中",
  };
  function tsunamiLabel(v) {
    return TSUNAMI_LABELS[v] || "不明";
  }

  // Coordinates come back as plain numbers in the v2 API, but this parses
  // defensively (same "accept whatever shape shows up" approach as
  // simbrief.js's coord() helper) in case a value ever arrives as a legacy
  // "N35.8" / "E137.7" string instead.
  function quakeCoord(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const m = String(v).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  // Normalizes a raw JMAQuake (code 551) message — from either the
  // production feed or the sandbox test feed — into the shape
  // renderQuakeCardHtml() expects.
  function normalizeJmaQuake(raw, isTest) {
    const eq = raw.earthquake || {};
    const h = eq.hypocenter || {};
    const depth = h.depth != null ? Number(String(h.depth).replace(/[^\d.]/g, "")) : NaN;
    return {
      isTest: !!isTest,
      earthquakeTime: eq.time || raw.time || "",
      maxScale: eq.maxScale != null ? Number(eq.maxScale) : null,
      domesticTsunami: eq.domesticTsunami || null,
      hypocenter: {
        name: h.name || null,
        lat: quakeCoord(h.latitude),
        lon: quakeCoord(h.longitude),
        depth: Number.isFinite(depth) ? depth : null,
        // -1 is P2PQuake's "unknown magnitude" sentinel.
        magnitude: h.magnitude != null && Number(h.magnitude) !== -1 ? Number(h.magnitude) : null,
      },
      points: (raw.points || [])
        .map((p) => ({ addr: p.addr || "", scale: Number(p.scale) }))
        .filter((p) => p.addr),
    };
  }

  // EEW (code 556) has NO earthquake.maxScale field — unlike JMAQuake
  // (551), the predicted intensity only exists per-area, in
  // areas[].scaleTo/scaleFrom (see the P2PQuake v2 schema). Reading
  // eq.maxScale here always came back undefined, which is why every EEW
  // popup/card previously showed 予想最大震度 as "不明" regardless of the
  // real forecast. scaleTo is used over scaleFrom since it's the upper
  // (worse-case) bound; 99 is P2PQuake's "〜程度以上" sentinel, mapped to
  // "7以上" in SCALE_LABELS above; -1 ("不明") is excluded from the max.
  function eewMaxScaleFromAreas(areas) {
    if (!Array.isArray(areas) || !areas.length) return null;
    let max = null;
    for (const a of areas) {
      const raw = a && (a.scaleTo != null ? a.scaleTo : a.scaleFrom);
      const v = raw != null ? Number(raw) : null;
      if (v != null && Number.isFinite(v) && v !== -1 && (max === null || v > max)) max = v;
    }
    return max;
  }

  // モバイルのボトムタブでは地震情報パネルが常時見えているわけではない
  // ので（開くにはタップが要る）、eew-popup（数秒で消える）だけだと
  // タイミングを逃した人が新着に気づけない。タブのアイコンに小さな
  // バッジを立てて、シートを開くまで消えないようにする — 詳細は
  // updateQuakeTabBadge() 参照。
  function markQuakeUnseen() {
    if (mobilePanelKind === "quake") return; // 今まさに見ている最中
    quakeUnseen = true;
    updateQuakeTabBadge();
  }

  function updateQuakeTabBadge() {
    const tab = document.getElementById("tab-quake");
    if (tab) tab.classList.toggle("has-badge", quakeUnseen);
  }

  function handleQuakeMessage(msg, isTest) {
    if (!msg || typeof msg.code !== "number") return;
    // The message's own `test` flag (when present) is more trustworthy
    // than inferring isTest purely from which socket delivered it — JMA
    // itself occasionally broadcasts drills marked test:true over the
    // *production* feed, and this makes sure those are still labeled
    // correctly instead of showing as a real alert.
    const flaggedTest = !!isTest || msg.test === true;
    if (msg.code === 551) {
      state.latestQuake = normalizeJmaQuake(msg, flaggedTest);
      renderQuakePanel();
      markQuakeUnseen();
    } else if (msg.code === 554) {
      // 緊急地震速報の発表検出 — a bare "something was just issued" signal
      // that arrives before the fuller 556 payload below, with no
      // hypocenter/area detail yet. Firing the popup here too, before 556
      // lands, means the person is warned at the earliest possible
      // moment — and still gets warned even in the (rare) case where the
      // fuller 556 message is the one that ends up delayed or dropped.
      showEewPopup({ isTest: flaggedTest, detectionOnly: true });
    } else if (msg.code === 556) {
      // 緊急地震速報（警報）— a forecast issued before shaking arrives, so
      // it typically carries only a provisional hypocenter/magnitude and a
      // list of alerted area codes (no addr names — those need a separate
      // area-code lookup table this client doesn't have), not the detailed
      // per-city points a confirmed 551 report has.
      if (msg.cancelled) {
        // A prior EEW for this event was withdrawn. Still worth surfacing
        // (silently clearing it could read as "nothing happened" when the
        // person may have just seen the original alert), but framed as a
        // cancellation rather than a fresh warning.
        state.latestEEW = null;
        renderQuakePanel();
        markQuakeUnseen();
        showEewPopup({ isTest: flaggedTest, cancelled: true });
        return;
      }
      const eq = msg.earthquake || {};
      const h = eq.hypocenter || {};
      state.latestEEW = {
        isTest: flaggedTest,
        hypocenterName: h.name || null,
        maxScale: eewMaxScaleFromAreas(msg.areas),
        areaCount: Array.isArray(msg.areas) ? msg.areas.length : null,
      };
      renderQuakePanel();
      markQuakeUnseen();
      showEewPopup(state.latestEEW);
    }
  }

  // ---- EEW top-slide-in popup ----
  // Independent of the (already-existing) in-panel EEW alert card — this
  // is a page-wide banner so an incoming EEW is noticed even if the user
  // isn't currently looking at the quake panel (e.g. scrolled deep into
  // the feed, or the panel is in the collapsed mobile bottom-sheet).
  // Reuses the same #eew-popup element across successive messages rather
  // than stacking multiple banners — a later, updated forecast for the
  // same event just replaces the content and restarts the timer/animation.
  let eewPopupTimer = null;

  // scripts/eew-push-bridge.js (server-side) relays 緊急地震速報 as a Web
  // Push notification so it still reaches the person even when this tab
  // isn't open/foregrounded — see sw.js's "push" handler. When the tab
  // *is* open, sw.js also forwards that same payload here via
  // postMessage, so it shows the richer in-app banner instead of relying
  // solely on the bare OS notification. The payload shape matches what
  // showEewPopup() already expects (isTest/cancelled/detectionOnly/
  // hypocenterName/maxScale/areaCount), so no translation is needed.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "eew") showEewPopup(event.data);
      if (event.data && event.data.type === "warning") showWarningBar(event.data);
    });
  }

  function showEewPopup(eew) {
    let el = document.getElementById("eew-popup");
    if (!el) {
      el = document.createElement("div");
      el.id = "eew-popup";
      el.className = "eew-popup";
      document.body.appendChild(el);
    }

    let bodyHtml;
    if (eew.cancelled) {
      el.classList.add("eew-popup-cancelled");
      bodyHtml = `
        <div class="eew-popup-title">緊急地震速報の取り消し</div>
        <div class="eew-popup-body">先ほどの緊急地震速報は取り消されました。</div>
      `;
    } else if (eew.detectionOnly) {
      el.classList.remove("eew-popup-cancelled");
      bodyHtml = `
        <div class="eew-popup-title">⚠️ 緊急地震速報を検知しました</div>
        <div class="eew-popup-body">詳細情報を確認中です…</div>
      `;
    } else {
      el.classList.remove("eew-popup-cancelled");
      bodyHtml = `
        <div class="eew-popup-title">⚠️ 緊急地震速報（予報）</div>
        <div class="eew-popup-body">
          震源: ${escapeHtml(eew.hypocenterName || "不明")}<br />
          予想最大震度: <b>${scaleLabel(eew.maxScale)}</b>
          ${eew.areaCount != null ? `　対象 ${eew.areaCount} 地域` : ""}
        </div>
      `;
    }

    el.innerHTML = `
      <div class="eew-popup-inner">
        ${eew.isTest ? `<div class="quake-test-badge">テスト表示</div>` : ""}
        ${bodyHtml}
      </div>
      <button type="button" class="eew-popup-close" aria-label="閉じる">✕</button>
    `;
    el.querySelector(".eew-popup-close").addEventListener("click", hideEewPopup);

    // Remove then re-add "show" (with a forced reflow in between) so the
    // slide-in animation restarts even if the popup is already visible
    // when a follow-up message arrives, instead of just sitting there
    // with the new text silently swapped in.
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");

    if (eewPopupTimer) clearTimeout(eewPopupTimer);
    // A detection-only or cancellation banner is lower-stakes than a full
    // forecast — no need to hold it on screen as long.
    eewPopupTimer = setTimeout(hideEewPopup, eew.detectionOnly || eew.cancelled ? 5000 : 8000);
  }

  function hideEewPopup() {
    const el = document.getElementById("eew-popup");
    if (!el) return;
    el.classList.remove("show");
    if (eewPopupTimer) { clearTimeout(eewPopupTimer); eewPopupTimer = null; }
  }

  // ---- 気象警報バー ----
  // showEewPopup/hideEewPopupと同じ「上から差し込むバナー」の仕組みを
  // 気象警報向けに複製したもの。トリガーは2経路:
  //   1) Web Push受信時、タブが開いていればsw.jsからのpostMessage
  //      (上のnavigator.serviceWorker "message" リスナー)。実際の検知・
  //      配信元は scripts/weather-warning-push-bridge.js。P2PQuakeの
  //      ようなリアルタイムWSフィードがJMA側に無いため、EEWと違って
  //      「タブを開いている間だけの直接接続」経路は存在しない —
  //      Web Pushが常に唯一の配信経路になる。
  //   2) 管理者パネルのテスト配信ボタン(isTest:trueでこの関数を直接
  //      呼ぶだけ — サーバーには一切ラウンドトリップしない。地震速報の
  //      テスト表示ボタンと同じ「実配信はしない」方針)
  let warningBarTimer = null;
  function showWarningBar(data) {
    let el = document.getElementById("warning-bar");
    if (!el) {
      el = document.createElement("div");
      el.id = "warning-bar";
      el.className = "warning-bar";
      document.body.appendChild(el);
    }

    el.innerHTML = `
      <div class="warning-bar-inner">
        ${data.isTest ? `<div class="quake-test-badge">テスト配信</div>` : ""}
        <div class="warning-bar-title">⚠️ ${escapeHtml(data.areaName || "気象警報・注意報")}</div>
        <div class="warning-bar-body">${escapeHtml(data.headline || "")}</div>
      </div>
      <button type="button" class="warning-bar-close" aria-label="閉じる">✕</button>
    `;
    el.querySelector(".warning-bar-close").addEventListener("click", hideWarningBar);

    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");

    if (warningBarTimer) clearTimeout(warningBarTimer);
    warningBarTimer = setTimeout(hideWarningBar, 10000);
  }

  function hideWarningBar() {
    const el = document.getElementById("warning-bar");
    if (!el) return;
    el.classList.remove("show");
    if (warningBarTimer) { clearTimeout(warningBarTimer); warningBarTimer = null; }
  }

  // 運営からのメッセージ(管理者パネル→POST /api/admin/announcements)を
  // 受信した全タブに即時表示するバナー。showWarningBar/hideWarningBarと
  // 同じ「上から差し込む」仕組みだが、配信経路はWebSocket
  // (announcement:new — handleWsMessage参照)のみで、Web Push側の
  // sw.js "message" リレーは使わない(警報と違い、こちらは配信元が
  // 自前のサーバーなので、タブが開いていれば必ずWSで直接届くため)。
  let announcementBarTimer = null;
  function showAnnouncementBar(data) {
    let el = document.getElementById("announcement-bar");
    if (!el) {
      el = document.createElement("div");
      el.id = "announcement-bar";
      el.className = "announcement-bar";
      document.body.appendChild(el);
    }

    el.innerHTML = `
      <div class="announcement-bar-inner">
        <div class="announcement-bar-title">📣 運営からのお知らせ</div>
        <div class="announcement-bar-body">${escapeHtml(data.message || "")}</div>
      </div>
      <button type="button" class="announcement-bar-close" aria-label="閉じる">✕</button>
    `;
    el.querySelector(".announcement-bar-close").addEventListener("click", hideAnnouncementBar);

    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");

    if (announcementBarTimer) clearTimeout(announcementBarTimer);
    announcementBarTimer = setTimeout(hideAnnouncementBar, 10000);
  }

  function hideAnnouncementBar() {
    const el = document.getElementById("announcement-bar");
    if (!el) return;
    el.classList.remove("show");
    if (announcementBarTimer) { clearTimeout(announcementBarTimer); announcementBarTimer = null; }
  }

  // Reconnect delay after the socket closes, doubling on each consecutive
  // failure (reset to base as soon as a connection actually opens) —
  // see the onclose handler in connectQuakeWS below for why a fixed
  // short delay was itself part of a previous bug.
  const QUAKE_WS_RETRY_BASE_MS = 5000;
  const QUAKE_WS_RETRY_MAX_MS = 5 * 60 * 1000;
  let quakeWsRetryDelay = QUAKE_WS_RETRY_BASE_MS;

  function connectQuakeWS() {
    if (quakeWsRetryTimer) { clearTimeout(quakeWsRetryTimer); quakeWsRetryTimer = null; }
    if (quakeWs) {
      quakeWs.onopen = quakeWs.onclose = quakeWs.onerror = quakeWs.onmessage = null;
      quakeWs.close();
    }
    try {
      quakeWs = new WebSocket(QUAKE_WS_URL);
    } catch {
      return; // e.g. no WebSocket support — panel just stays in its empty state
    }

    quakeWs.onopen = () => {
      state.quakeWsConnected = true;
      renderQuakePanel();
      quakeWsRetryDelay = QUAKE_WS_RETRY_BASE_MS; // connection succeeded — reset backoff
    };
    quakeWs.onclose = () => {
      state.quakeWsConnected = false;
      renderQuakePanel();
      // Exponential backoff (capped) instead of a fixed 5s retry: a fixed
      // short delay is exactly what turned a previous, unrelated bug (see
      // the watchdog comment below) into a reconnect-storm that got this
      // client's IP rate-limited by P2PQuake (WS handshake failing with
      // HTTP 429). Backing off further on repeated failures is standard
      // practice against exactly that failure mode, whatever causes it.
      quakeWsRetryTimer = setTimeout(connectQuakeWS, quakeWsRetryDelay);
      quakeWsRetryDelay = Math.min(quakeWsRetryDelay * 2, QUAKE_WS_RETRY_MAX_MS);
    };
    quakeWs.onerror = () => quakeWs.close();
    quakeWs.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleQuakeMessage(msg, false);
    };
  }

  // ---- Reconnect watchdog + REST safety net ----
  // Belt-and-suspenders for the always-on production socket above. None
  // of this can help while the JS itself isn't running at all (phone
  // screen locked, tab fully killed by the OS) — only server-driven push
  // notifications can guarantee delivery in that case — but it closes
  // the much more common gap where the tab/app is open (foreground or
  // background) yet the socket has silently died or a message slipped
  // through a brief reconnect window.
  //
  // 1) Force a fresh connection whenever the tab becomes visible again or
  //    the network comes back — but only if there genuinely isn't a live
  //    connection already (OPEN or actively CONNECTING) AND there isn't
  //    already a backoff retry scheduled. Calling connectQuakeWS()
  //    directly here would cancel that pending retry and attempt
  //    immediately instead — exactly what kept re-triggering the 429s
  //    below no matter how far the backoff had grown.
  function reconnectQuakeWSIfNeeded() {
    if (quakeWs && (quakeWs.readyState === WebSocket.OPEN || quakeWs.readyState === WebSocket.CONNECTING)) return;
    if (quakeWsRetryTimer) return; // a backoff retry is already scheduled — let it run its course
    connectQuakeWS();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reconnectQuakeWSIfNeeded();
      pollQuakeHistory();
    }
  });
  window.addEventListener("online", () => {
    reconnectQuakeWSIfNeeded();
    pollQuakeHistory();
  });

  // 2) While the tab is visible, periodically confirm the socket is
  //    actually still open (not just "not yet told us it closed") and
  //    reconnect if it's genuinely gone — but ONLY based on readyState,
  //    never on "it's been quiet for a while". P2PQuake's feed can
  //    legitimately go quiet for long stretches (most of the time,
  //    nothing happens — that's the point), so an earlier version of
  //    this watchdog treated that normal silence as a dead connection
  //    and force-reconnected roughly every 45–65s, forever, for as long
  //    as the tab was open. That reconnect storm is what got this
  //    client's IP rate-limited (WS handshake failing with HTTP 429).
  //
  //    Just as important: this must NOT fire while a backoff retry is
  //    already scheduled (quakeWsRetryTimer set). Every close (including
  //    a failed 429 handshake) leaves the socket in CLOSED right up
  //    until that scheduled retry runs — so without this check, the
  //    watchdog was calling connectQuakeWS() itself every 20s regardless,
  //    which cancels the pending backoff timer and attempts immediately,
  //    silently overriding the whole backoff and re-triggering the 429
  //    in a tight ~20s loop no matter how far quakeWsRetryDelay had grown.
  const QUAKE_WATCHDOG_INTERVAL_MS = 20000;
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (quakeWsRetryTimer) return; // already backing off — don't preempt it
    const socketBroken = !quakeWs || quakeWs.readyState === WebSocket.CLOSED || quakeWs.readyState === WebSocket.CLOSING;
    if (socketBroken) connectQuakeWS();
  }, QUAKE_WATCHDOG_INTERVAL_MS);

  // 3) Independent of the WebSocket entirely: poll P2PQuake's plain HTTPS
  //    history endpoint for the latest EEW-detection (554) / EEW (556)
  //    entries every QUAKE_POLL_INTERVAL_MS, and replay anything newer
  //    than the last item this client has already seen. This still works
  //    even during the brief windows above where the socket is
  //    reconnecting, catching what it would otherwise miss.
  const QUAKE_POLL_INTERVAL_MS = 20000;
  let quakeLastSeenTime = null; // ms epoch of the newest history item processed so far

  // How long after it was issued a 554/556 item still counts as "currently
  // in effect" for the reload check below. EEW forecasts are only useful
  // for the short window before/while shaking is happening, so this is
  // deliberately short — long enough to cover someone reloading the page
  // moments after an alert, not long enough to resurface something that's
  // already resolved.
  const EEW_STILL_ACTIVE_MS = 3 * 60 * 1000;

  async function pollQuakeHistory() {
    try {
      const res = await fetch("https://api.p2pquake.net/v2/history?codes=554&codes=556&limit=5");
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;
      const sorted = list
        .filter((m) => m && m.time)
        .map((m) => ({ msg: m, t: new Date(m.time).getTime() }))
        .filter((x) => Number.isFinite(x.t))
        .sort((a, b) => a.t - b.t);

      const isFirstPoll = quakeLastSeenTime === null;

      for (const { msg, t } of sorted) {
        // The very first poll just establishes a baseline — it shouldn't
        // replay whatever was already in the history before this client
        // ever connected (that would surface an old, already-resolved
        // alert as if it just happened).
        if (!isFirstPoll && t > quakeLastSeenTime) {
          handleQuakeMessage(msg, false);
        }
        if (quakeLastSeenTime === null || t > quakeLastSeenTime) quakeLastSeenTime = t;
      }

      // Reload-during-an-active-EEW case: the baseline-only pass above
      // means a page load right after a real EEW would otherwise show
      // nothing at all — no popup, empty panel — even though the alert is
      // still current. If the newest history item is a still-fresh,
      // non-cancelled 554/556, replay it through the normal
      // handleQuakeMessage() path (same as a live WS message) so the
      // popup and panel come back up to date on load too.
      if (isFirstPoll && sorted.length) {
        const latest = sorted[sorted.length - 1];
        const stillActive = Date.now() - latest.t <= EEW_STILL_ACTIVE_MS;
        const isResolvedCancel = latest.msg.code === 556 && latest.msg.cancelled;
        if (stillActive && !isResolvedCancel) {
          handleQuakeMessage(latest.msg, false);
        }
      }
    } catch {
      // Offline, or the request was blocked — the WebSocket above is
      // still the primary path; this is only a supplementary check.
    }
  }

  function startQuakePolling() {
    pollQuakeHistory();
    setInterval(() => {
      if (document.visibilityState === "visible") pollQuakeHistory();
    }, QUAKE_POLL_INTERVAL_MS);
  }

  // "テスト表示" now connects to P2PQuake's public sandbox feed instead of
  // faking a single message locally — it periodically broadcasts real
  // simulated 551 (地震情報) / 556 (緊急地震速報) messages in the exact same
  // shape as the production feed, so this reuses handleQuakeMessage()
  // unchanged, just flagged isTest so the UI never confuses it for a real
  // report. Independent of connectQuakeWS()'s always-on production socket.
  const QUAKE_SANDBOX_WS_URL = "wss://api-realtime-sandbox.p2pquake.net/v2/ws";
  let quakeSandboxWs = null;
  // After a failed attempt (e.g. P2PQuake rate-limiting this IP — see the
  // production-socket comments above), briefly disable the test button
  // instead of leaving it instantly clickable again. Nothing here
  // auto-retries on its own, but without this a person naturally clicks
  // "テスト表示" again right away when it doesn't seem to work, which just
  // piles more attempts onto the very thing that's already being rejected.
  const QUAKE_SANDBOX_RETRY_COOLDOWN_MS = 15000;
  let quakeSandboxCooldownUntil = 0;

  function connectQuakeSandboxWS() {
    if (quakeSandboxWs) return; // already connecting or connected
    if (Date.now() < quakeSandboxCooldownUntil) {
      toast("接続に失敗しました。しばらく待ってから再度お試しください。");
      return;
    }
    state.quakeTestConnecting = true;
    renderQuakePanel();
    try {
      quakeSandboxWs = new WebSocket(QUAKE_SANDBOX_WS_URL);
    } catch {
      quakeSandboxWs = null;
      state.quakeTestConnecting = false;
      quakeSandboxCooldownUntil = Date.now() + QUAKE_SANDBOX_RETRY_COOLDOWN_MS;
      renderQuakePanel();
      toast("サンドボックスへの接続に失敗しました");
      return;
    }
    quakeSandboxWs.onopen = () => {
      state.quakeTestMode = true;
      state.quakeTestConnecting = false;
      renderQuakePanel();
      toast("地震情報サンドボックスに接続しました。テストデータの配信をお待ちください…");
    };
    quakeSandboxWs.onclose = () => {
      const wasActive = state.quakeTestMode;
      const failedToConnect = state.quakeTestConnecting; // reached onclose without ever hitting onopen
      quakeSandboxWs = null;
      state.quakeTestMode = false;
      state.quakeTestConnecting = false;
      renderQuakePanel();
      if (failedToConnect) {
        quakeSandboxCooldownUntil = Date.now() + QUAKE_SANDBOX_RETRY_COOLDOWN_MS;
        toast("接続に失敗しました。しばらく待ってから再度お試しください。");
      } else if (wasActive) {
        toast("地震情報サンドボックスから切断しました");
      }
    };
    quakeSandboxWs.onerror = () => { if (quakeSandboxWs) quakeSandboxWs.close(); };
    quakeSandboxWs.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleQuakeMessage(msg, true);
    };
  }

  function disconnectQuakeSandboxWS() {
    if (!quakeSandboxWs) return;
    quakeSandboxWs.onopen = quakeSandboxWs.onclose = quakeSandboxWs.onerror = quakeSandboxWs.onmessage = null;
    quakeSandboxWs.close();
    quakeSandboxWs = null;
    state.quakeTestMode = false;
    state.quakeTestConnecting = false;
    renderQuakePanel();
  }

  function toggleQuakeSandbox() {
    if (state.quakeTestMode || state.quakeTestConnecting) {
      disconnectQuakeSandboxWS();
    } else {
      connectQuakeSandboxWS();
    }
  }

  // Small Leaflet map pinning the hypocenter — same tile layer/pattern as
  // initFlightDetailMap() below, just a single marker instead of a route.
  // Scoped to `container` (rather than a global id) since the quake panel
  // can be rendered into more than one place at once — the desktop
  // sidebar slot and, on mobile, the bottom-sheet panel opened from the
  // tab bar — and a duplicate id would confuse getElementById.
  function initQuakeMap(h, container) {
    const mapEl = container && container.querySelector(".quake-map");
    // Also skip if the container is currently hidden (e.g. the desktop
    // sidebar slot, which stays in the DOM but display:none on mobile) —
    // Leaflet measures a 0x0 box there and ends up with a broken map.
    if (!mapEl || typeof L === "undefined" || h.lat == null || h.lon == null) return;
    if (mapEl.offsetParent === null) return;
    if (quakeMapInstance) { quakeMapInstance.remove(); quakeMapInstance = null; }

    const map = L.map(mapEl, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
    L.tileLayer(TILE_URL, {
      maxZoom: 18,
      subdomains: TILE_SUBDOMAINS,
      attribution: TILE_ATTRIBUTION,
    }).addTo(map);
    L.circleMarker([h.lat, h.lon], { radius: 9, color: "#ff6b7a", weight: 2, fillColor: "#ff6b7a", fillOpacity: 0.55 })
      .addTo(map).bindTooltip(h.name || "震源", { permanent: false });
    map.setView([h.lat, h.lon], 6);
    // Same fix as initFullscreenMap(): the container can measure as 0px
    // right after insertion, leaving tiles blank until a resize happens.
    setTimeout(() => map.invalidateSize(), 60);
    quakeMapInstance = map;
  }

  function renderEewAlertHtml(eew) {
    return `
      <div class="quake-eew-alert">
        ${eew.isTest ? `<div class="quake-test-badge">テスト表示</div>` : ""}
        <div class="quake-eew-title">⚠️ 緊急地震速報（予報）</div>
        <div class="quake-eew-body">
          震源: ${escapeHtml(eew.hypocenterName || "不明")}<br />
          予想最大震度: <b>${scaleLabel(eew.maxScale)}</b>
          ${eew.areaCount != null ? `　対象 ${eew.areaCount} 地域` : ""}
        </div>
      </div>
    `;
  }

  function renderQuakeCardHtml(q) {
    const h = q.hypocenter || {};
    const hasMap = h.lat != null && h.lon != null;
    const topPoints = (q.points || [])
      .slice()
      .sort((a, b) => (b.scale ?? -999) - (a.scale ?? -999))
      .slice(0, 6);

    return `
      <div class="quake-card">
        ${q.isTest ? `<div class="quake-test-badge">テスト表示</div>` : ""}
        ${q.earthquakeTime ? `<div class="quake-time">${escapeHtml(q.earthquakeTime)}</div>` : ""}
        <div class="quake-max-scale">最大震度 <b>${scaleLabel(q.maxScale)}</b></div>
        <div class="quake-fields">
          <div><span class="quake-field-label">震源</span>${escapeHtml(h.name || "不明")}</div>
          <div><span class="quake-field-label">マグニチュード</span>${h.magnitude != null ? `M${h.magnitude}` : "不明"}</div>
          <div><span class="quake-field-label">深さ</span>${h.depth != null ? `${h.depth}km` : "不明"}</div>
          <div><span class="quake-field-label">津波</span>${tsunamiLabel(q.domesticTsunami)}</div>
        </div>
        ${hasMap ? `<div class="quake-map"></div>` : ""}
        ${topPoints.length ? `
          <div class="quake-points">
            ${topPoints.map((p) => `<span class="quake-point-chip">${escapeHtml(p.addr)} 震度${scaleLabel(p.scale)}</span>`).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  // renderQuakePanel() used to always target a single element — either the
  // one explicitly passed in, or #quake-slot by default. That default is
  // the desktop sidebar, which is display:none on mobile (<900px — see
  // .mobile-tabbar in styles.css); the mobile bottom sheet renders this
  // same panel into a *different* element (#mobile-panel-content, opened
  // via openMobilePanel("quake")). Every call site that reacts to live
  // data — handleQuakeMessage's WS/poll messages, connectQuakeWS's own
  // connection-status updates, the sandbox test connection — only ever
  // called the plain default form, so on mobile those updates landed on
  // the hidden desktop copy while the visible bottom sheet sat stale until
  // it was closed and reopened (which re-renders fresh from current
  // state). Rather than needing every such call site to know to use a
  // special "everywhere" variant, the default (no-arg) call itself now
  // renders into every currently-mounted copy.
  function renderQuakePanel(targetEl) {
    if (targetEl) {
      renderQuakePanelInto(targetEl);
      return;
    }
    renderQuakePanelInto();
    if (mobilePanelKind === "quake") {
      const content = document.getElementById("mobile-panel-content");
      if (content) renderQuakePanelInto(content);
    }
  }

  function renderQuakePanelInto(targetEl) {
    const slot = targetEl || document.getElementById("quake-slot");
    if (!slot) return; // not mounted yet (e.g. still on the auth screen)

    const q = state.latestQuake;
    const eew = state.latestEEW;
    const testBtnLabel = state.quakeTestConnecting ? "接続中…" : (state.quakeTestMode ? "テスト解除" : "テスト表示");

    slot.innerHTML = `
      <div class="quake-panel">
        <div class="quake-panel-head">
          <div class="quake-panel-title">🌐 地震情報</div>
          <div class="quake-ws-indicator">
            <span class="quake-ws-dot ${state.quakeWsConnected ? "live" : ""}"></span>
            ${state.quakeTestMode ? "テストモード受信中" : (state.quakeWsConnected ? "受信中" : "接続中...")}
          </div>
        </div>
        ${eew ? renderEewAlertHtml(eew) : ""}
        ${q ? renderQuakeCardHtml(q) : `<div class="quake-empty">受信した地震情報はまだありません</div>`}
        <button type="button" class="btn btn-ghost quake-test-btn" id="quake-test-btn" ${state.quakeTestConnecting ? "disabled" : ""}>${testBtnLabel}</button>
        ${renderWeatherSectionHtml()}
        ${renderWarningSectionHtml()}
      </div>
    `;

    slot.querySelector("#quake-test-btn").addEventListener("click", toggleQuakeSandbox);
    if (q) initQuakeMap(q.hypocenter, slot);
    wireWeatherSection(slot);
    wireWarningSection(slot);
  }

  // ---------------------------------------------------------------- ランキング簡易表示（地震情報パネル下部）
  // 地震情報パネルのすぐ下に、今月の飛行距離トップ5を表示する(フル版は
  // openLeaderboardModal — ヘッダーの「ランキング」ボタンから開く)。
  // 未ログインの訪問者にも見せる(quake/newsパネルと同方針)ので、
  // ログイン状態に関わらずboot()から呼ぶ。
  async function loadSidebarLeaderboard() {
    try {
      const { entries } = await api("/api/logbook/leaderboard?period=month&metric=distance&limit=5");
      state.sidebarLeaderboard = entries;
      renderSidebarLeaderboard();
    } catch {
      // Non-critical panel — fail silently, same as popular flights/news.
    }
  }

  // renderQuakePanel()と同じ「現在マウントされている全コピーに描く」方針
  // — デスクトップの#sidebar-leaderboard-slot(地震情報パネルの直下)と、
  // モバイルのボトムシート(地震情報タブを開いている間だけ存在する
  // #mobile-sidebar-leaderboard-slot)の両方を、呼び出し側が気にせず一度に
  // 更新できるようにする。
  function renderSidebarLeaderboard(targetEl) {
    if (targetEl) {
      renderSidebarLeaderboardInto(targetEl);
      return;
    }
    const desktopSlot = document.getElementById("sidebar-leaderboard-slot");
    if (desktopSlot) renderSidebarLeaderboardInto(desktopSlot);
    if (mobilePanelKind === "quake") {
      const mobileSlot = document.getElementById("mobile-sidebar-leaderboard-slot");
      if (mobileSlot) renderSidebarLeaderboardInto(mobileSlot);
    }
  }

  function renderSidebarLeaderboardInto(slot) {
    const list = state.sidebarLeaderboard || [];
    slot.innerHTML = `
      <div class="events-sidebar-panel">
        <div class="events-sidebar-title"><span>🏆</span> 今月のランキング</div>
        ${!list.length
          ? `<div class="quake-empty">今月のフライト記録はまだありません</div>`
          : `<div class="events-sidebar-list">
              ${list.map((entry, i) => `
                <button type="button" class="events-sidebar-item" data-callsign="${escapeHtml(entry.user.callsign)}">
                  <div class="sidebar-leaderboard-lead">
                    <span class="sidebar-leaderboard-rank">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
                    ${avatarHtml(entry.user, 28)}
                  </div>
                  <div class="events-sidebar-item-body">
                    <div class="events-sidebar-item-title">${escapeHtml(entry.user.name)}</div>
                    <div class="events-sidebar-item-meta">
                      <span>@${escapeHtml(entry.user.callsign)}</span>
                      <span>・</span>
                      <span>${Math.round(entry.distanceNm).toLocaleString()}nm</span>
                    </div>
                  </div>
                </button>
              `).join("")}
            </div>`
        }
        <button type="button" class="btn btn-ghost btn-block events-sidebar-viewall" id="sidebar-leaderboard-viewall">すべて見る</button>
      </div>
    `;

    slot.querySelectorAll(".events-sidebar-item").forEach((btn) => {
      btn.addEventListener("click", () => openUserProfile(btn.dataset.callsign));
    });
    const viewAllBtn = slot.querySelector("#sidebar-leaderboard-viewall");
    if (viewAllBtn) viewAllBtn.addEventListener("click", openLeaderboardModal);
  }

  // ---------------------------------------------------------------- 天気予報 (OpenWeatherMap)
  // 地震情報パネルの下部に地域検索窓を設置し、検索した地域の今日/明日の
  // 天気サマリーを表示する。「詳細を見る」から現在の気温・体感温度・湿度
  // ・風速・日の出日の入りと、3時間ごとの詳細予報を見られるモーダルを開く。
  // OpenWeatherMapのAPIキーはサーバー側(routes/weather.js)にのみ置かれ、
  // フロントは自前サーバー経由(/api/weather/...)でのみ叩く。
  function weatherIconUrl(icon) {
    return icon ? `https://openweathermap.org/img/wn/${icon}@2x.png` : "";
  }

  function weatherDayCardHtml(label, day) {
    if (!day) {
      return `
        <div class="weather-day-card weather-day-empty">
          <div class="weather-day-label">${label}</div>
          <div class="weather-day-desc">データなし</div>
        </div>
      `;
    }
    return `
      <div class="weather-day-card">
        <div class="weather-day-label">${label}</div>
        ${day.icon ? `<img class="weather-day-icon" src="${weatherIconUrl(day.icon)}" alt="${escapeHtml(day.weather)}" loading="lazy" />` : ""}
        <div class="weather-day-temp"><b>${day.tempMax}°</b><span class="weather-day-temp-min">/ ${day.tempMin}°</span></div>
        <div class="weather-day-desc">${escapeHtml(day.weather)}</div>
        ${day.pop != null ? `<div class="weather-day-pop">☔ ${day.pop}%</div>` : ""}
      </div>
    `;
  }

  function renderWeatherSectionHtml() {
    const w = state.weather;
    return `
      <div class="weather-section">
        <div class="weather-section-title">🌤️ 天気予報</div>
        <div class="weather-search" id="weather-search">
          <span class="material-symbols-rounded feed-search-icon" aria-hidden="true">search</span>
          <input type="text" id="weather-search-input" placeholder="地域名で検索（例: 名古屋）" autocomplete="off" value="${escapeHtml(w.query)}" />
          <button type="button" class="feed-search-clear${w.query ? "" : " hidden"}" id="weather-search-clear" title="検索をクリア">✕</button>
        </div>
        ${w.loading ? `<div class="spinner-row">読み込み中...</div>` : ""}
        ${w.error ? `<div class="error-banner weather-error">${escapeHtml(w.error)}</div>` : ""}
        ${w.candidates && w.candidates.length ? `
          <div class="weather-candidates">
            ${w.candidates.map((c, i) => `
              <button type="button" class="weather-candidate-chip" data-index="${i}">
                ${escapeHtml(c.displayName)}${c.state ? `（${escapeHtml(c.state)}）` : ""}${c.country ? ` ${escapeHtml(c.country)}` : ""}
              </button>
            `).join("")}
          </div>
        ` : ""}
        ${w.data && w.location ? `
          <div class="weather-result">
            <div class="weather-result-location">📍 ${escapeHtml(w.location.displayName)}${w.location.country ? `（${escapeHtml(w.location.country)}）` : ""}</div>
            <div class="weather-day-grid">
              ${weatherDayCardHtml("今日", w.data.today)}
              ${weatherDayCardHtml("明日", w.data.tomorrow)}
            </div>
            <button type="button" class="btn btn-ghost btn-block weather-detail-btn" id="weather-detail-btn">詳細を見る</button>
          </div>
        ` : ""}
      </div>
    `;
  }

  // renderQuakePanel()が呼ばれるたびにDOMごと再生成されるため、検索欄の
  // input/keydownリスナーと候補チップ、詳細ボタンのクリックをそのたびに
  // 配線し直す。feed-search-input(フィード検索)と同じ、350msデバウンス
  // + Enterキーで即時実行という規約に合わせている。
  function wireWeatherSection(slot) {
    const input = slot.querySelector("#weather-search-input");
    const clearBtn = slot.querySelector("#weather-search-clear");
    if (input) {
      input.addEventListener("input", (e) => {
        const value = e.target.value;
        if (clearBtn) clearBtn.classList.toggle("hidden", !value);
        clearTimeout(weatherSearchTimer);
        weatherSearchTimer = setTimeout(() => searchWeatherLocations(value), 500);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        clearTimeout(weatherSearchTimer);
        searchWeatherLocations(input.value);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        clearTimeout(weatherSearchTimer);
        clearWeatherSearch();
      });
    }
    slot.querySelectorAll(".weather-candidate-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const loc = state.weather.candidates[Number(btn.dataset.index)];
        if (loc) selectWeatherLocation(loc);
      });
    });
    const detailBtn = slot.querySelector("#weather-detail-btn");
    if (detailBtn) detailBtn.addEventListener("click", openWeatherDetail);
  }

  // 地域名から候補地(緯度経度)を検索する。1件だけヒットした場合は
  // ユーザーに選ばせず自動的にその地域の天気を取得する。
  async function searchWeatherLocations(query) {
    const trimmed = query.trim();
    state.weather.query = trimmed;
    state.weather.candidates = null;
    state.weather.data = null;
    state.weather.location = null;
    state.weather.error = "";
    if (!trimmed) {
      renderQuakePanelEverywhere();
      return;
    }

    state.weather.loading = true;
    renderQuakePanelEverywhere();
    try {
      const res = await fetch(`/api/weather/search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "地域の検索に失敗しました。");
      if (!data.results || !data.results.length) {
        state.weather.error = "該当する地域が見つかりませんでした。";
        state.weather.loading = false;
        renderQuakePanelEverywhere();
        return;
      }
      if (data.results.length === 1) {
        state.weather.loading = false;
        await selectWeatherLocation(data.results[0]);
        return;
      }
      state.weather.candidates = data.results;
    } catch (err) {
      state.weather.error = err.message;
    } finally {
      state.weather.loading = false;
      renderQuakePanelEverywhere();
    }
  }

  // 選択された地域の今日/明日の天気サマリーと詳細データを取得する。
  async function selectWeatherLocation(loc) {
    state.weather.location = loc;
    state.weather.candidates = null;
    state.weather.data = null;
    state.weather.error = "";
    state.weather.loading = true;
    renderQuakePanelEverywhere();
    try {
      const res = await fetch(`/api/weather/summary?lat=${encodeURIComponent(loc.lat)}&lon=${encodeURIComponent(loc.lon)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "天気情報の取得に失敗しました。");
      state.weather.data = data;
    } catch (err) {
      state.weather.error = err.message;
    } finally {
      state.weather.loading = false;
      renderQuakePanelEverywhere();
    }
  }

  function clearWeatherSearch() {
    state.weather = { query: "", loading: false, error: "", candidates: null, location: null, data: null };
    renderQuakePanelEverywhere();
  }

  function weatherHourlyRowHtml(h) {
    // dtTextはサーバーが検索対象地域のタイムゾーンで組み立てた
    // "YYYY-MM-DD HH:MM:SS" 文字列なので、そのまま月/日 時:分として使う
    // （ブラウザ側のローカルタイムゾーンには変換しない）。
    const label = h.dtText ? `${h.dtText.slice(5, 10).replace("-", "/")} ${h.dtText.slice(11, 16)}` : "";
    return `
      <div class="weather-hour-row">
        <div class="weather-hour-time">${escapeHtml(label)}</div>
        ${h.icon ? `<img class="weather-hour-icon" src="${weatherIconUrl(h.icon)}" alt="${escapeHtml(h.weather)}" loading="lazy" />` : ""}
        <div class="weather-hour-desc">${escapeHtml(h.weather)}</div>
        <div class="weather-hour-temp">${h.temp}°</div>
        <div class="weather-hour-pop">☔${h.pop}%</div>
      </div>
    `;
  }

  function weatherDetailHtml() {
    const w = state.weather;
    const c = w.data.current || {};
    const city = w.data.city || {};
    const rows = [];
    if (c.feelsLike != null) rows.push(["体感温度", `${c.feelsLike}°`]);
    if (c.humidity != null) rows.push(["湿度", `${c.humidity}%`]);
    if (c.pressure != null) rows.push(["気圧", `${c.pressure}hPa`]);
    if (c.windSpeed != null) rows.push(["風速", `${c.windSpeed}m/s`]);
    if (city.sunrise) rows.push(["日の出", new Date(city.sunrise * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })]);
    if (city.sunset) rows.push(["日の入り", new Date(city.sunset * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })]);

    return `
      <div class="weather-detail">
        <div class="weather-detail-tag">🌤️ 天気予報詳細</div>
        <div class="weather-detail-location"><b>${escapeHtml(w.location.displayName)}</b>${city.country ? `（${escapeHtml(city.country)}）` : ""}</div>
        <div class="weather-detail-current">
          ${c.icon ? `<img class="weather-detail-current-icon" src="${weatherIconUrl(c.icon)}" alt="${escapeHtml(c.weather || "")}" />` : ""}
          <div class="weather-detail-current-temp">${c.temp}°</div>
          <div class="weather-detail-current-desc">${escapeHtml(c.weather || "")}</div>
        </div>
        ${rows.length ? `
          <div class="weather-detail-grid">
            ${rows.map(([label, value]) => `
              <div class="weather-detail-row">
                <span class="weather-detail-label">${label}</span>
                <span class="weather-detail-value">${value}</span>
              </div>
            `).join("")}
          </div>
        ` : ""}
        <div class="weather-day-grid" style="margin-top:14px;">
          ${weatherDayCardHtml("今日", w.data.today)}
          ${weatherDayCardHtml("明日", w.data.tomorrow)}
        </div>
        ${(w.data.hourly || []).length ? `
          <div class="weather-hourly-title">3時間ごとの予報</div>
          <div class="weather-hourly-list">
            ${w.data.hourly.map(weatherHourlyRowHtml).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  function openWeatherDetail() {
    const w = state.weather;
    if (!w.data || !w.location) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal weather-detail-modal">
        <button class="modal-close" id="weather-detail-close">✕</button>
        ${weatherDetailHtml()}
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("weather-detail-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  // ---------------------------------------------------------------- 気象警報・注意報 (気象庁, 地震情報パネル下部)
  // 天気予報検索窓のさらに下に、選んだ都道府県の気象警報・注意報の見出し
  // 文を表示する。データ元はsrc/routes/weather.jsのGET /api/weather/
  // warnings（気象庁の非公式JSONをサーバー側でプロキシ）。
  //
  // 2026年5月29日の気象庁システム改定で新形式のJSONに変わっており、
  // 個々の警報種別を確実に判別できる保証がまだ薄いため、サーバー側は
  // 発表文の見出し(headlineText)をそのまま返すだけに留めている。見出し
  // が取得できなかった場合も「警報は無い」と決めつけず、気象庁サイトへの
  // リンクで手動確認を促す(詳細はsrc/routes/weather.jsのコメント参照)。
  async function loadWarningAreas() {
    if (state.warningAlert.areas || state.warningAlert.areasLoading) return;
    state.warningAlert.areasLoading = true;
    try {
      const { areas } = await api("/api/weather/warning-areas");
      state.warningAlert.areas = areas;
    } catch {
      // 選択肢が読めなくてもパネル全体を壊さない — プルダウンが空の
      // まま表示され、後述のrenderで「読み込みに失敗」を出す。
    } finally {
      state.warningAlert.areasLoading = false;
      renderQuakePanelEverywhere();
    }
  }

  async function selectWarningArea(areaCode) {
    state.warningAlert.areaCode = areaCode;
    state.warningAlert.data = null;
    state.warningAlert.error = "";
    if (areaCode) localStorage.setItem(WARNING_AREA_KEY, areaCode);
    else localStorage.removeItem(WARNING_AREA_KEY);
    // ログイン中はアカウントにも保存し、サーバー側のpush配信/WSバーの
    // 対象に含める(未ログインならローカル表示のみで、通知は届かない)。
    if (state.token) {
      api("/api/weather/warning-subscription", { method: "PUT", body: JSON.stringify({ areaCode }) }).catch(() => {
        // 保存に失敗しても閲覧自体は続けられるので、パネルは壊さない。
      });
    }
    if (!areaCode) { renderQuakePanelEverywhere(); return; }

    state.warningAlert.loading = true;
    renderQuakePanelEverywhere();
    try {
      state.warningAlert.data = await api(`/api/weather/warnings?areaCode=${encodeURIComponent(areaCode)}`);
    } catch (err) {
      state.warningAlert.error = err.message;
    } finally {
      state.warningAlert.loading = false;
      renderQuakePanelEverywhere();
    }
  }

  // ログイン直後、アカウントに保存されている地域とこのブラウザの
  // localStorageの選択にズレがないか確認する。サーバー側の値がある
  // 場合はそちらを正として採用(他の端末で選んだ設定を引き継ぐため)、
  // サーバーが未設定でローカルだけ選んでいる場合はサーバーへ反映する。
  async function syncWarningAreaSubscription() {
    try {
      const { areaCode: serverAreaCode } = await api("/api/weather/warning-subscription");
      const localAreaCode = state.warningAlert.areaCode;
      if (serverAreaCode && serverAreaCode !== localAreaCode) {
        await selectWarningArea(serverAreaCode);
      } else if (!serverAreaCode && localAreaCode) {
        api("/api/weather/warning-subscription", { method: "PUT", body: JSON.stringify({ areaCode: localAreaCode }) }).catch(() => {});
      }
    } catch {
      // 起動をブロックしない — 失敗してもローカルの選択のまま動作を続ける。
    }
  }

  function renderWarningSectionHtml() {
    const w = state.warningAlert;
    const options = (w.areas || [])
      .map((a) => `<option value="${a.code}" ${a.code === w.areaCode ? "selected" : ""}>${escapeHtml(a.name)}</option>`)
      .join("");

    let body = "";
    if (w.error) {
      body = `<div class="error-banner">${escapeHtml(w.error)}</div>`;
    } else if (w.loading && !w.data) {
      body = `<div class="spinner-row">読み込み中...</div>`;
    } else if (w.data) {
      const d = w.data;
      const updated = d.reportDatetime ? fmtTime(d.reportDatetime) : "";
      body = `
        <div class="warning-alert-result">
          ${d.headlines
            ? `<ul class="warning-alert-headlines">${d.headlines.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
            : `<div class="warning-alert-none">${d.fetchError
                ? "気象庁の情報取得に失敗しました。時間をおいて再度お試しください。"
                : "見出しを取得できませんでした。最新の状況は気象庁サイトでご確認ください。"}</div>`
          }
          <div class="warning-alert-meta">
            ${d.publishingOffice ? `${escapeHtml(d.publishingOffice)}発表　` : ""}${updated ? `${updated}更新　` : ""}
            <a href="${d.officialUrl}" target="_blank" rel="noopener noreferrer">気象庁サイトで詳細を見る →</a>
          </div>
        </div>
      `;
    }

    return `
      <div class="weather-section warning-alert-section">
        <div class="weather-section-title">⚠️ 気象警報・注意報</div>
        <select class="warning-alert-select" id="warning-alert-select">
          <option value="">地域を選択...</option>
          ${options}
        </select>
        ${body}
      </div>
    `;
  }

  function wireWarningSection(slot) {
    const select = slot.querySelector("#warning-alert-select");
    if (!select) return;
    if (!state.warningAlert.areas) loadWarningAreas();
    else if (state.warningAlert.areaCode && !state.warningAlert.data && !state.warningAlert.loading && !state.warningAlert.error) {
      selectWarningArea(state.warningAlert.areaCode); // localStorageから復元した地域を初回だけ自動取得
    }
    select.addEventListener("change", () => selectWarningArea(select.value));
  }

  // ---------------------------------------------------------------- render: auth
  // New account creation is Google-only (see routes/auth.js — POST
  // /api/auth/register is disabled server-side for security). This screen
  // therefore only offers: (1) a callsign/password form for people who
  // already have a password-based account, and (2) Google sign-in, which
  // both logs in existing Google-linked users and creates new accounts
  // (via openGoogleCallsignModal, triggered when needsCallsign comes back).
  function renderAuthScreen() {
    root.innerHTML = `
      <div class="auth-wrap">
        <button type="button" class="btn btn-ghost topbar-btn icon-only auth-theme-toggle" id="auth-theme-toggle-btn" title="表示モードを切り替え" aria-label="表示モードを切り替え">
          <span class="material-symbols-rounded theme-toggle-icon" aria-hidden="true">light_mode</span>
        </button>
        <h1>✈️ AeroSocial</h1>
        <p class="sub">パイロットのためのソーシャルフィード</p>
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
        <a href="/api/auth/google/start" class="btn btn-ghost btn-block" style="margin-top:8px;">Googleでログイン（別の方法）</a>
        <p class="sub" style="margin-top:10px; font-size:12px; color:var(--text-dim);">
          セキュリティ強化のため、新規アカウントの作成はGoogleログインのみとなります。
        </p>
        <div class="auth-divider"><span>既存のコールサインでログイン</span></div>
        <form id="auth-form">
          <div class="field">
            <label>コールサイン</label>
            <input name="callsign" placeholder="例: SKYHAWK1" autocomplete="username" required />
          </div>
          <div class="field">
            <label>パスワード</label>
            <input name="password" type="password" placeholder="8文字以上" autocomplete="current-password" required />
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">ログイン</button>
        </form>
      </div>
    `;

    document.getElementById("auth-theme-toggle-btn").addEventListener("click", toggleTheme);
    syncThemeToggleIcons();

    document.getElementById("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = document.getElementById("auth-submit");
      submitBtn.disabled = true;
      state.error = "";
      try {
        await login(fd.get("callsign"), fd.get("password"));
        await checkAdminStatus();
        render();
        await loadFeed();
        connectWS();
      } catch (err) {
        state.error = err.message;
        renderAuthScreen();
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- render: main
  function renderMainScreen() {
    root.innerHTML = `
      <div class="app-shell">
        <div class="ptr-indicator" id="ptr-indicator">
          <span class="material-symbols-rounded ptr-icon" id="ptr-icon" aria-hidden="true">refresh</span>
        </div>
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark"><span class="material-symbols-rounded" aria-hidden="true">flight</span></span>
            <span class="brand-name">AeroSocial</span>
          </div>
          <div class="topbar-actions">
            <div class="ws-indicator"><span class="ws-dot" id="ws-dot"></span></div>
            <button type="button" class="btn btn-ghost topbar-btn" id="my-posts-btn"><span class="material-symbols-rounded" aria-hidden="true">dynamic_feed</span>マイ投稿</button>
            <button type="button" class="btn btn-ghost topbar-btn" id="events-btn"><span class="material-symbols-rounded" aria-hidden="true">event</span>イベント</button>
            <button type="button" class="btn btn-ghost topbar-btn" id="leaderboard-btn"><span class="material-symbols-rounded" aria-hidden="true">military_tech</span>ランキング</button>
            <button type="button" class="btn btn-ghost topbar-btn" id="news-hub-btn"><span class="material-symbols-rounded" aria-hidden="true">newspaper</span>ニュース</button>
            <button type="button" class="btn btn-ghost topbar-btn messages-btn" id="messages-btn"><span class="material-symbols-rounded" aria-hidden="true">campaign</span>メッセージ</button>
            <button type="button" class="btn btn-ghost topbar-btn" id="memo-btn"><span class="material-symbols-rounded" aria-hidden="true">edit_note</span>メモ</button>
            <button type="button" class="btn btn-ghost topbar-btn" id="notif-settings-btn"><span class="material-symbols-rounded" aria-hidden="true">settings</span>設定</button>
            ${state.isAdmin ? `<button type="button" class="btn btn-ghost topbar-btn" id="admin-panel-btn"><span class="material-symbols-rounded" aria-hidden="true">admin_panel_settings</span>管理者パネル</button>` : ""}
            <div class="topbar-divider"></div>
            <button type="button" class="btn btn-ghost topbar-btn icon-only" id="theme-toggle-btn" title="表示モードを切り替え" aria-label="表示モードを切り替え">
              <span class="material-symbols-rounded theme-toggle-icon" aria-hidden="true">light_mode</span>
            </button>
            <div id="avatar-slot"></div>
          </div>
        </div>

        <div class="main-grid">
          <div class="sidebar sidebar-left">
            <div id="quake-slot"></div>
            <div id="sidebar-leaderboard-slot"></div>
          </div>

          <div class="feed-column">
            <div class="composer" id="composer">
              <div class="composer-top">
                ${avatarHtml(state.user, 40)}
                <textarea id="composer-text" placeholder="フライトの様子をシェアしよう...（画像は貼り付けやドラッグ＆ドロップでも追加できます）" rows="2"></textarea>
              </div>
              <div id="composer-preview-slot"></div>
              <div id="composer-flight-slot"></div>
              <div id="composer-poll-slot"></div>
              <div class="composer-actions">
                <div>
                  <button class="icon-btn" id="pick-image-btn" title="画像を追加（複数選択・貼り付け・ドラッグ＆ドロップ対応、最大${MAX_COMPOSER_IMAGES}枚）"><span class="material-symbols-rounded" aria-hidden="true">image</span></button>
                  <input type="file" id="composer-file-input" accept="image/*" multiple class="hidden-file-input" />
                  <button class="icon-btn" id="pick-poll-btn" title="投票を追加"><span class="material-symbols-rounded" aria-hidden="true">bar_chart</span></button>
                </div>
                <div style="display:flex; gap:8px;">
                  <button type="button" class="btn btn-ghost" id="simbrief-import-btn">📋 SimBrief</button>
                  <button class="btn btn-primary" id="composer-submit">投稿</button>
                </div>
              </div>
            </div>

            <div class="feed-search" id="feed-search">
              <span class="material-symbols-rounded feed-search-icon" aria-hidden="true">search</span>
              <input type="text" id="feed-search-input" placeholder="ユーザー・投稿を検索..." autocomplete="off" value="${escapeHtml(state.searchQuery)}" />
              <button type="button" class="feed-search-clear${state.searchQuery ? "" : " hidden"}" id="feed-search-clear" title="検索をクリア">✕</button>
            </div>

            <div id="feed-stats-slot"></div>
            <div id="feed-list"></div>
          </div>

          <div class="sidebar sidebar-right">
            <div id="popular-flights-slot"></div>
            <div id="news-panel-slot"></div>
          </div>
        </div>

        <nav class="mobile-tabbar" id="mobile-tabbar">
          <button type="button" class="tab-btn active" id="tab-home" data-tab="home" title="ホーム"><span class="material-symbols-rounded" aria-hidden="true">home</span></button>
          <button type="button" class="tab-btn" id="tab-flights" data-tab="flights" title="人気のフライト"><span class="material-symbols-rounded" aria-hidden="true">emoji_events</span></button>
          <button type="button" class="tab-btn" id="tab-quake" data-tab="quake" title="地震情報"><span class="material-symbols-rounded" aria-hidden="true">public</span></button>
          <button type="button" class="tab-btn" id="tab-menu" data-tab="menu" title="メニュー"><span class="material-symbols-rounded" aria-hidden="true">menu</span></button>
        </nav>

        <!-- 常時表示のメモ用フローティングボタン。他の全画面ビュー(フライト
             詳細・ニュース・画像拡大表示など)を開いている最中でも押せる
             よう、CSS側でそれらより高いz-indexにしてある。メモを開く手段を
             メニューの奥に隠さず、どの画面からでも一発で前面に呼び出せる
             ようにするためのショートカット。 -->
        <button type="button" class="memo-fab" id="memo-fab" title="メモを開く" aria-label="メモを開く">
          <span aria-hidden="true">📝</span>
        </button>
      </div>
    `;

    setupMobileTabbar();
    document.getElementById("memo-fab").addEventListener("click", openMemoModal);

    document.getElementById("avatar-slot").innerHTML = avatarHtml(state.user, 34);
    document.getElementById("avatar-slot").addEventListener("click", openProfileModal);
    document.getElementById("my-posts-btn").addEventListener("click", () => openUserProfile(state.user.callsign));
    document.getElementById("events-btn").addEventListener("click", openEventsModal);
    document.getElementById("leaderboard-btn").addEventListener("click", openLeaderboardModal);
    document.getElementById("news-hub-btn").addEventListener("click", openNewsHubModal);
    document.getElementById("messages-btn").addEventListener("click", openMessagesModal);
    document.getElementById("memo-btn").addEventListener("click", openMemoModal);
    document.getElementById("notif-settings-btn").addEventListener("click", openNotificationSettingsModal);
    if (state.isAdmin) {
      document.getElementById("admin-panel-btn").addEventListener("click", openAdminPanelModal);
    }
    document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);
    syncThemeToggleIcons();

    document.getElementById("pick-image-btn").addEventListener("click", () => {
      document.getElementById("composer-file-input").click();
    });

    document.getElementById("pick-poll-btn").addEventListener("click", () => {
      if (state.pendingPoll) {
        // Toggle off: same button removes an in-progress poll builder.
        state.pendingPoll = null;
      } else {
        state.pendingPoll = { options: ["", ""] };
      }
      renderComposerPollBuilder();
    });

    document.getElementById("composer-file-input").addEventListener("change", (e) => {
      addComposerFiles(e.target.files);
      e.target.value = ""; // allow re-selecting the same file(s) later
    });

    document.getElementById("composer-submit").addEventListener("click", onSubmitPost);
    document.getElementById("simbrief-import-btn").addEventListener("click", openSimbriefModal);

    const feedSearchInput = document.getElementById("feed-search-input");
    const feedSearchClear = document.getElementById("feed-search-clear");
    let feedSearchTimer = null;
    feedSearchInput.addEventListener("input", (e) => {
      const value = e.target.value;
      feedSearchClear.classList.toggle("hidden", !value);
      clearTimeout(feedSearchTimer);
      feedSearchTimer = setTimeout(() => runFeedSearch(value), 350);
    });
    // Enter triggers the search immediately instead of waiting out the
    // debounce — same convention as the admin panel's search boxes.
    feedSearchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      clearTimeout(feedSearchTimer);
      runFeedSearch(feedSearchInput.value);
    });
    feedSearchClear.addEventListener("click", () => {
      feedSearchInput.value = "";
      feedSearchClear.classList.add("hidden");
      clearTimeout(feedSearchTimer);
      clearFeedSearch();
      feedSearchInput.focus();
    });

    // Paste an image (e.g. copied from a screenshot tool or a browser tab)
    // directly into the composer.
    const composerEl = document.getElementById("composer");
    composerEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        e.preventDefault();
        addComposerFiles(files);
      }
    });

    // Drag-and-drop images onto the composer.
    ["dragenter", "dragover"].forEach((evt) => {
      composerEl.addEventListener(evt, (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        composerEl.classList.add("drag-over");
      });
    });
    ["dragleave", "dragend"].forEach((evt) => {
      composerEl.addEventListener(evt, () => composerEl.classList.remove("drag-over"));
    });
    composerEl.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      composerEl.classList.remove("drag-over");
      addComposerFiles(e.dataTransfer.files);
    });

    renderComposerPreview();
    renderComposerFlightPreview();
    renderComposerPollBuilder();
    updateWsIndicator();
    renderFeedList();
    renderPopularFlights();
    renderQuakePanel();
    renderMessagesBadge();
  }

  // ---------------------------------------------------------------- mobile bottom tab bar
  // X(Twitter)-style bottom nav, shown only below the 900px breakpoint
  // (see .mobile-tabbar in styles.css) where the left/right sidebars are
  // hidden entirely. Home / Popular Flights / Earthquake info are
  // consolidated here as icon-only buttons; tapping Popular Flights or
  // Earthquake opens that same panel content in a bottom sheet instead of
  // permanently occupying screen width.
  function setActiveTab(name) {
    document.querySelectorAll(".mobile-tabbar .tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === name);
    });
  }

  function setupMobileTabbar() {
    const bar = document.getElementById("mobile-tabbar");
    if (!bar) return;
    document.getElementById("tab-home").addEventListener("click", () => {
      setActiveTab("home");
      document.querySelector(".feed-column")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.getElementById("tab-flights").addEventListener("click", () => {
      setActiveTab("flights");
      openMobilePanel("flights");
    });
    document.getElementById("tab-quake").addEventListener("click", () => {
      setActiveTab("quake");
      openMobilePanel("quake");
    });
    document.getElementById("tab-menu").addEventListener("click", () => {
      setActiveTab("menu");
      openMobileMenu();
    });
  }

  // Bottom-sheet stand-in for the topbar's action buttons (マイ投稿 /
  // イベント / 設定 / 管理者パネル / プロフィール編集), which are hidden below
  // the 900px breakpoint (see .topbar-actions in styles.css) so the topbar
  // only shows the logo there. Everything they did is still reachable from
  // here via the "menu" tab in .mobile-tabbar.
  function openMobileMenu() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop mobile-panel-backdrop";
    overlay.innerHTML = `
      <div class="modal mobile-panel-sheet">
        <div class="mobile-panel-sheet-handle"></div>
        <button class="modal-close" id="mobile-menu-close">✕</button>
        <h2 style="font-size:15px;">メニュー</h2>
        <div class="sheet-menu-list">
          <button type="button" class="btn btn-ghost" id="menu-profile-btn"><span class="material-symbols-rounded" aria-hidden="true">person</span>プロフィール編集</button>
          <button type="button" class="btn btn-ghost" id="menu-my-posts-btn"><span class="material-symbols-rounded" aria-hidden="true">dynamic_feed</span>マイ投稿</button>
          <button type="button" class="btn btn-ghost" id="menu-events-btn"><span class="material-symbols-rounded" aria-hidden="true">event</span>イベント</button>
          <button type="button" class="btn btn-ghost" id="menu-leaderboard-btn"><span class="material-symbols-rounded" aria-hidden="true">military_tech</span>ランキング</button>
          <button type="button" class="btn btn-ghost" id="menu-news-hub-btn"><span class="material-symbols-rounded" aria-hidden="true">newspaper</span>ニュース</button>
          <button type="button" class="btn btn-ghost messages-btn" id="menu-messages-btn"><span class="material-symbols-rounded" aria-hidden="true">campaign</span>メッセージ</button>
          <button type="button" class="btn btn-ghost" id="menu-memo-btn"><span class="material-symbols-rounded" aria-hidden="true">edit_note</span>メモ</button>
          <button type="button" class="btn btn-ghost" id="menu-settings-btn"><span class="material-symbols-rounded" aria-hidden="true">settings</span>設定</button>
          ${state.isAdmin ? `<button type="button" class="btn btn-ghost" id="menu-admin-btn"><span class="material-symbols-rounded" aria-hidden="true">admin_panel_settings</span>管理者パネル</button>` : ""}
          <button type="button" class="btn btn-ghost" id="menu-theme-toggle-btn">
            <span class="material-symbols-rounded theme-toggle-icon" aria-hidden="true">light_mode</span>
            <span id="menu-theme-toggle-label"></span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    syncThemeToggleIcons();
    renderMessagesBadge();

    function close() {
      overlay.remove();
      setActiveTab("home");
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("mobile-menu-close").addEventListener("click", close);

    document.getElementById("menu-profile-btn").addEventListener("click", () => { close(); openProfileModal(); });
    document.getElementById("menu-my-posts-btn").addEventListener("click", () => { close(); openUserProfile(state.user.callsign); });
    document.getElementById("menu-events-btn").addEventListener("click", () => { close(); openEventsModal(); });
    document.getElementById("menu-leaderboard-btn").addEventListener("click", () => { close(); openLeaderboardModal(); });
    document.getElementById("menu-news-hub-btn").addEventListener("click", () => { close(); openNewsHubModal(); });
    document.getElementById("menu-messages-btn").addEventListener("click", () => { close(); openMessagesModal(); });
    document.getElementById("menu-memo-btn").addEventListener("click", () => { close(); openMemoModal(); });
    document.getElementById("menu-settings-btn").addEventListener("click", () => { close(); openNotificationSettingsModal(); });
    if (state.isAdmin) {
      document.getElementById("menu-admin-btn").addEventListener("click", () => { close(); openAdminPanelModal(); });
    }
    document.getElementById("menu-theme-toggle-btn").addEventListener("click", () => { toggleTheme(); close(); });
  }

  // Tracks which panel is currently showing in the mobile bottom sheet (or
  // null if it's closed) — read by renderQuakePanelEverywhere() below so a
  // weather-search re-render can reach the sheet's #mobile-panel-content
  // when it's open on "quake", instead of only ever touching the desktop
  // sidebar's #quake-slot (which is display:none on mobile — see
  // .mobile-tabbar in styles.css).
  let mobilePanelKind = null;

  // Opens a bottom-sheet modal populated by the same renderer used for the
  // desktop sidebar (renderPopularFlights / renderQuakePanel), just handed
  // this sheet's own content element as the render target instead.
  function openMobilePanel(kind) {
    const titles = { flights: "🏆 人気のフライト", quake: "🌐 地震情報" };
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop mobile-panel-backdrop";
    overlay.innerHTML = `
      <div class="modal mobile-panel-sheet">
        <div class="mobile-panel-sheet-handle"></div>
        <button class="modal-close" id="mobile-panel-close">✕</button>
        <h2 style="font-size:15px;">${titles[kind] || ""}</h2>
        <div id="mobile-panel-content"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    mobilePanelKind = kind;

    const content = document.getElementById("mobile-panel-content");
    if (kind === "flights") {
      renderPopularFlights(content);
      // ニュースは「人気のフライトの下部」という要件をモバイルでも守る
      // ため、同じボトムシートの続きにappendする(専用タブは増やさない)。
      renderNewsPanel(content, true);
    } else if (kind === "quake") {
      quakeUnseen = false;
      updateQuakeTabBadge();
      renderQuakePanel(content);
      // ランキングは地震情報パネルの下に続けて表示する(デスクトップの
      // #sidebar-leaderboard-slotと同じ並び)。専用の子要素を1つ用意し、
      // renderSidebarLeaderboard()から見つけて再描画できるようにする
      // (mobilePanelKind === "quake"の間だけ存在する)。
      const leaderboardSlot = document.createElement("div");
      leaderboardSlot.id = "mobile-sidebar-leaderboard-slot";
      content.appendChild(leaderboardSlot);
      renderSidebarLeaderboardInto(leaderboardSlot);
    }

    function close() {
      overlay.remove();
      mobilePanelKind = null;
      setActiveTab("home");
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("mobile-panel-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  // Kept as a thin alias: renderQuakePanel() (no-arg) now does this itself
  // (see its dispatcher above), so this just avoids having to touch the
  // weather-search call sites that already use this name.
  function renderQuakePanelEverywhere() {
    renderQuakePanel();
  }

  // Renders the poll option list into #composer-poll-slot from
  // state.pendingPoll. Only called when the *number* of options changes
  // (add/remove) — each option <input>'s own "input" listener writes
  // keystrokes straight into state.pendingPoll.options[i] without
  // re-rendering, so typing never loses focus or cursor position (same
  // reasoning as why renderComposerPreview() isn't called per keystroke
  // elsewhere in the composer).
  function renderComposerPollBuilder() {
    const slot = document.getElementById("composer-poll-slot");
    if (!slot) return;
    if (!state.pendingPoll) { slot.innerHTML = ""; return; }
    const { options } = state.pendingPoll;

    slot.innerHTML = `
      <div class="poll-builder">
        <div class="poll-builder-head">
          <span class="material-symbols-rounded" aria-hidden="true">bar_chart</span>
          投票を作成（本文が質問文になります）
          <button type="button" class="poll-remove-btn" id="remove-poll-btn" title="投票を削除">✕</button>
        </div>
        ${options.map((opt, i) => `
          <div class="poll-builder-option">
            <input
              type="text"
              class="poll-builder-input"
              data-poll-option-index="${i}"
              placeholder="選択肢 ${i + 1}"
              maxlength="${POLL_MAX_OPTION_LEN}"
              value="${escapeHtml(opt)}"
            />
            ${options.length > POLL_MIN_OPTIONS ? `<button type="button" class="poll-remove-btn" data-remove-poll-option="${i}" title="この選択肢を削除">✕</button>` : ""}
          </div>
        `).join("")}
        ${options.length < POLL_MAX_OPTIONS ? `
          <button type="button" class="btn btn-ghost poll-builder-add" id="add-poll-option-btn">＋ 選択肢を追加</button>
        ` : ""}
      </div>
    `;

    document.getElementById("remove-poll-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingPoll = null;
      renderComposerPollBuilder();
    });

    slot.querySelectorAll("[data-poll-option-index]").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.pollOptionIndex);
        if (state.pendingPoll) state.pendingPoll.options[i] = input.value;
      });
    });

    slot.querySelectorAll("[data-remove-poll-option]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number(btn.dataset.removePollOption);
        state.pendingPoll.options.splice(i, 1);
        renderComposerPollBuilder();
      });
    });

    const addBtn = document.getElementById("add-poll-option-btn");
    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.pendingPoll.options.push("");
        renderComposerPollBuilder();
      });
    }
  }

  function renderComposerFlightPreview() {
    const slot = document.getElementById("composer-flight-slot");
    if (!slot) return;
    if (!state.pendingFlight) { slot.innerHTML = ""; return; }
    const f = state.pendingFlight;
    slot.innerHTML = `
      <div class="flight-card flight-card-rich" style="position:relative;">
        <button class="remove-preview" id="remove-flight-btn" style="position:absolute; top:8px; right:8px;">✕</button>
        ${flightCardHtml(f)}
      </div>
    `;
    document.getElementById("remove-flight-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingFlight = null;
      renderComposerFlightPreview();
    });
    slot.querySelector(".flight-card").addEventListener("click", () => openFlightDetail(f));
  }

  // ---------------------------------------------------------------- SimBrief import
  function openSimbriefModal() {
    const savedUsername = localStorage.getItem(SIMBRIEF_USERNAME_KEY) || "";
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-close" id="simbrief-close">✕</button>
        <h2>SimBriefからインポート</h2>
        <div class="field">
          <label>SimBriefユーザー名</label>
          <input id="simbrief-username" value="${escapeHtml(savedUsername)}" placeholder="SimBriefのユーザー名" />
        </div>
        <button type="button" class="btn btn-primary btn-block" id="simbrief-fetch-btn">最新のフライトプランを取得</button>
        <div id="simbrief-result" style="margin-top:14px;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("simbrief-close").addEventListener("click", () => overlay.remove());

    document.getElementById("simbrief-fetch-btn").addEventListener("click", async () => {
      const usernameInput = document.getElementById("simbrief-username");
      const username = usernameInput.value.trim();
      if (!username) return;
      localStorage.setItem(SIMBRIEF_USERNAME_KEY, username);

      const fetchBtn = document.getElementById("simbrief-fetch-btn");
      const resultEl = document.getElementById("simbrief-result");
      fetchBtn.disabled = true;
      resultEl.innerHTML = `<div class="spinner-row">取得中...</div>`;
      try {
        const { flight } = await api(`/api/simbrief/${encodeURIComponent(username)}`);
        resultEl.innerHTML = `
          <div class="flight-card flight-card-rich">
            ${flightCardHtml(flight)}
          </div>
          <button type="button" class="btn btn-primary btn-block" id="simbrief-use-btn" style="margin-top:10px;">この内容で投稿に追加</button>
        `;
        resultEl.querySelector(".flight-card").addEventListener("click", () => openFlightDetail(flight));
        document.getElementById("simbrief-use-btn").addEventListener("click", () => {
          state.pendingFlight = flight;
          overlay.remove();
          renderComposerFlightPreview();
          toast("フライト情報を追加しました。投稿ボタンで送信できます。");
        });
      } catch (err) {
        resultEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      } finally {
        fetchBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- Memo (ニーボード)
  // VATSIMでのフライト中に使うことを想定したメモ機能。テキストメモに加えて
  // 手書きスケッチ(Pointer Events経由。iPadのApple Pencilはpointerdown/move
  // イベントのpointerType === "pen"とe.pressureで筆圧を拾える)を1枚のメモに
  // 両方持たせられる。SimBriefからのフライト情報取得は既存の
  // GET /api/simbrief/:username(openSimbriefModalと同じエンドポイント)を
  // 再利用し、テキスト欄にフォーマット済みで挿入する。
  function openMemoModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop news-hub-backdrop memo-backdrop";
    overlay.innerHTML = `
      <div class="modal news-hub-modal memo-modal">
        <div class="news-hub-masthead">
          <button type="button" class="news-hub-back" id="memo-close" aria-label="閉じる">
            <span class="news-hub-back-arrow">←</span>
          </button>
          <div class="news-hub-masthead-text">
            <div class="news-hub-masthead-title"><span>📝</span> メモ（ニーボード）</div>
            <div class="news-hub-masthead-sub">VATSIMのフライト中に。手書き（Apple Pencil対応）も使えます</div>
          </div>
          <button type="button" class="btn btn-ghost memo-list-toggle" id="memo-list-toggle" title="メモ一覧">☰ 一覧</button>
        </div>
        <div class="memo-body" id="memo-body">
          <div class="memo-sidebar" id="memo-sidebar">
            <button type="button" class="btn btn-primary btn-block" id="memo-new-btn">＋ 新規メモ</button>
            <div class="memo-list" id="memo-list"></div>
          </div>
          <div class="memo-editor" id="memo-editor"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add("news-hub-open");

    let memos = [];
    let currentId = null;
    let dirty = false;
    // ペン設定はモーダルを開いている間だけ保持(メモを切り替えても引き継ぐ)。
    const drawTool = { color: "#1a2233", size: 3, eraser: false };
    let canvasCtx = null;
    let hasDrawing = false;
    let drawing = false;
    let lastPoint = null;

    function close() {
      if (dirty && !confirm("保存されていない変更があります。閉じますか？")) return;
      overlay.remove();
      // ニュースなど他の全画面ビューを裏に開いたままメモだけ閉じた場合に
      // 誤って背面スクロールを有効化してしまわないよう、同種のオーバーレイが
      // 他に残っていないか確認してからクラスを外す。
      if (!document.querySelector(".news-hub-backdrop")) {
        document.body.classList.remove("news-hub-open");
      }
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("memo-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.getElementById("memo-list-toggle").addEventListener("click", () => {
      overlay.classList.toggle("memo-sidebar-open");
    });
    document.getElementById("memo-new-btn").addEventListener("click", () => {
      if (dirty && !confirm("保存されていない変更があります。破棄して新規作成しますか？")) return;
      overlay.classList.remove("memo-sidebar-open");
      loadEditor(null);
    });

    async function refreshList() {
      const listEl = document.getElementById("memo-list");
      if (!listEl) return;
      listEl.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
      try {
        const { memos: fetched } = await api("/api/memos");
        memos = fetched;
        renderList();
      } catch (err) {
        listEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderList() {
      const listEl = document.getElementById("memo-list");
      if (!listEl) return;
      if (!memos.length) {
        listEl.innerHTML = `<div class="memo-empty">まだメモがありません</div>`;
        return;
      }
      listEl.innerHTML = memos.map((m) => `
        <button type="button" class="memo-list-item${m.id === currentId ? " active" : ""}" data-id="${m.id}">
          <div class="memo-list-item-title">${escapeHtml(m.title)}${m.hasDrawing ? " ✏️" : ""}</div>
          <div class="memo-list-item-preview">${m.textPreview ? escapeHtml(m.textPreview) : "（本文なし）"}</div>
          <div class="memo-list-item-time">${fmtTime(m.updatedAt)}</div>
        </button>
      `).join("");
      listEl.querySelectorAll(".memo-list-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.id === currentId) { overlay.classList.remove("memo-sidebar-open"); return; }
          if (dirty && !confirm("保存されていない変更があります。破棄して切り替えますか？")) return;
          overlay.classList.remove("memo-sidebar-open");
          loadEditor(btn.dataset.id);
        });
      });
    }

    async function loadEditor(id) {
      currentId = id;
      dirty = false;
      renderList();
      const editorEl = document.getElementById("memo-editor");
      if (!id) {
        renderEditorForm({ title: "", textContent: "", drawingData: null, updatedAt: null });
        return;
      }
      editorEl.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
      try {
        const { memo } = await api(`/api/memos/${id}`);
        renderEditorForm(memo);
      } catch (err) {
        editorEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderEditorForm(memo) {
      const editorEl = document.getElementById("memo-editor");
      editorEl.innerHTML = `
        <div class="memo-editor-toolbar">
          <input id="memo-title-input" class="memo-title-input" maxlength="${MEMO_TITLE_MAX}" placeholder="タイトル（未入力は「無題のメモ」）" value="${escapeHtml(memo.title || "")}" />
          <button type="button" class="btn btn-ghost" id="memo-simbrief-btn">📋 SimBriefから取得</button>
          <button type="button" class="btn btn-ghost" id="memo-pip-btn" title="別ウィンドウで常時最前面に表示（Chrome/Edge）">🪟 常時表示</button>
        </div>
        <div class="memo-canvas-toolbar">
          <input type="color" id="memo-pen-color" value="${drawTool.color}" title="ペンの色" />
          <input type="range" id="memo-pen-size" min="1" max="16" value="${drawTool.size}" title="太さ" />
          <button type="button" class="btn btn-ghost memo-tool-btn" id="memo-eraser-btn" title="消しゴム">🩹 消しゴム</button>
          <button type="button" class="btn btn-ghost" id="memo-canvas-clear-btn" title="手書きを全消去">🗑️ 全消去</button>
        </div>
        <div class="memo-canvas-wrap">
          <canvas id="memo-canvas" class="memo-canvas"></canvas>
        </div>
        <textarea id="memo-text-input" class="memo-text-input" maxlength="${MEMO_TEXT_MAX}" placeholder="テキストメモ（クリアランス、周波数、メモ書きなど）">${escapeHtml(memo.textContent || "")}</textarea>
        <div class="memo-editor-actions">
          <div id="memo-status" class="memo-status">${memo.updatedAt ? `最終更新: ${fmtTime(memo.updatedAt)}` : "未保存"}</div>
          <div class="memo-editor-actions-buttons">
            ${currentId ? `<button type="button" class="btn btn-ghost" id="memo-delete-btn">削除</button>` : ""}
            <button type="button" class="btn btn-primary" id="memo-save-btn">保存</button>
          </div>
        </div>
      `;

      setupCanvas(memo.drawingData);

      document.getElementById("memo-title-input").addEventListener("input", markDirty);
      document.getElementById("memo-text-input").addEventListener("input", markDirty);
      document.getElementById("memo-simbrief-btn").addEventListener("click", handleSimbriefImport);
      document.getElementById("memo-pip-btn").addEventListener("click", handleOpenPip);
      document.getElementById("memo-save-btn").addEventListener("click", handleSave);
      if (currentId) {
        document.getElementById("memo-delete-btn").addEventListener("click", handleDelete);
      }
      document.getElementById("memo-pen-color").addEventListener("input", (e) => {
        drawTool.color = e.target.value;
        drawTool.eraser = false;
        updateEraserBtn();
      });
      document.getElementById("memo-pen-size").addEventListener("input", (e) => {
        drawTool.size = Number(e.target.value);
      });
      document.getElementById("memo-eraser-btn").addEventListener("click", () => {
        drawTool.eraser = !drawTool.eraser;
        updateEraserBtn();
      });
      document.getElementById("memo-canvas-clear-btn").addEventListener("click", () => {
        if (!canvasCtx) return;
        const { width, height } = canvasCtx.canvas;
        canvasCtx.save();
        canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
        canvasCtx.fillStyle = "#ffffff";
        canvasCtx.fillRect(0, 0, width, height);
        canvasCtx.restore();
        hasDrawing = false;
        markDirty();
      });
      updateEraserBtn();
    }

    function updateEraserBtn() {
      const btn = document.getElementById("memo-eraser-btn");
      if (btn) btn.classList.toggle("active", drawTool.eraser);
    }

    function markDirty() {
      dirty = true;
      const statusEl = document.getElementById("memo-status");
      if (statusEl) statusEl.textContent = "未保存の変更があります";
    }

    // 手書きキャンバス。Pointer Eventsでマウス/タッチ/Apple Pencilを統一的に
    // 扱う。pointerType === "pen"のときはe.pressureで筆圧に応じて線の太さを
    // 変える(マウスやタッチではpressureが0や0.5固定のことが多いため、その
    // 場合は設定した太さをそのまま使う)。CSS側のtouch-action:noneと合わせて、
    // 描画中にiPadの画面がスクロールしてしまうのを防ぐ。
    function setupCanvas(existingDrawingDataUrl) {
      const canvas = document.getElementById("memo-canvas");
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = wrap.clientWidth || 320;
      const cssHeight = Math.round(cssWidth * 0.62);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      canvasCtx = ctx;
      // 既存の手書きがある場合、画像の読み込みが非同期のためレースで
      // 保存時にnullを送ってしまわないよう、hasDrawingは同期的に立てておく。
      hasDrawing = !!existingDrawingDataUrl;

      if (existingDrawingDataUrl) {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, cssWidth, cssHeight); };
        img.src = existingDrawingDataUrl;
      }

      function pointFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
      function strokeWidthFor(e) {
        if (e.pointerType === "pen" && e.pressure > 0) {
          return Math.max(1, drawTool.size * e.pressure * 1.6);
        }
        return drawTool.size;
      }

      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drawing = true;
        lastPoint = pointFromEvent(e);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drawing) return;
        e.preventDefault();
        const point = pointFromEvent(e);
        ctx.strokeStyle = drawTool.eraser ? "#ffffff" : drawTool.color;
        ctx.lineWidth = drawTool.eraser ? drawTool.size * 3 : strokeWidthFor(e);
        ctx.beginPath();
        ctx.moveTo(lastPoint.x, lastPoint.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        lastPoint = point;
        hasDrawing = true;
        markDirty();
      });
      function endStroke(e) {
        if (!drawing) return;
        drawing = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }
      canvas.addEventListener("pointerup", endStroke);
      canvas.addEventListener("pointercancel", endStroke);
      canvas.addEventListener("pointerleave", endStroke);
    }

    async function handleSimbriefImport() {
      const savedUsername = localStorage.getItem(SIMBRIEF_USERNAME_KEY) || "";
      const username = prompt("SimBriefのユーザー名を入力してください", savedUsername);
      if (!username) return;
      localStorage.setItem(SIMBRIEF_USERNAME_KEY, username);
      const btn = document.getElementById("memo-simbrief-btn");
      btn.disabled = true;
      btn.textContent = "取得中...";
      try {
        const { flight } = await api(`/api/simbrief/${encodeURIComponent(username)}`);
        const lines = [
          `--- SimBriefから取得 (${fmtTime(new Date().toISOString())}) ---`,
          flight.callsign ? `コールサイン: ${flight.callsign}` : null,
          (flight.originIcao || flight.destIcao) ? `区間: ${flight.originIcao || "----"} → ${flight.destIcao || "----"}` : null,
          flight.route ? `ルート: ${flight.route}` : null,
          flight.cruiseAlt ? `巡航高度: FL${Math.round(flight.cruiseAlt / 100)}` : null,
          flight.aircraftIcao ? `機材: ${flight.aircraftIcao}` : null,
          flight.altIcao ? `代替空港: ${flight.altIcao}` : null,
          "",
        ].filter((l) => l !== null).join("\n");
        const textEl = document.getElementById("memo-text-input");
        textEl.value = (lines + (textEl.value ? "\n" + textEl.value : "")).slice(0, MEMO_TEXT_MAX);
        markDirty();
        toast("SimBriefの情報をメモに追加しました。");
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "📋 SimBriefから取得";
      }
    }

    function currentDrawingDataUrl() {
      if (!canvasCtx || !hasDrawing) return null;
      return canvasCtx.canvas.toDataURL("image/png");
    }

    async function handleSave() {
      const saveBtn = document.getElementById("memo-save-btn");
      const title = document.getElementById("memo-title-input").value.trim();
      const textContent = document.getElementById("memo-text-input").value;
      const drawingData = currentDrawingDataUrl();
      saveBtn.disabled = true;
      try {
        let memo;
        if (currentId) {
          ({ memo } = await api(`/api/memos/${currentId}`, {
            method: "PUT",
            body: JSON.stringify({ title, textContent, drawingData }),
          }));
        } else {
          ({ memo } = await api("/api/memos", {
            method: "POST",
            body: JSON.stringify({ title, textContent, drawingData }),
          }));
        }
        dirty = false;
        toast("メモを保存しました。");
        await refreshList();
        await loadEditor(memo.id);
        return memo;
      } catch (err) {
        toast(err.message);
        saveBtn.disabled = false;
        return null;
      }
    }

    async function handleDelete() {
      if (!currentId) return;
      if (!confirm("このメモを削除しますか？元に戻せません。")) return;
      try {
        await api(`/api/memos/${currentId}`, { method: "DELETE" });
        toast("メモを削除しました。");
        currentId = null;
        dirty = false;
        await refreshList();
        loadEditor(null);
      } catch (err) {
        toast(err.message);
      }
    }

    // MSFSなどをウィンドウ/ボーダーレス全画面で起動している上に常に浮かせて
    // おける別ウィンドウでメモを開く。開く前に必ず一度保存し(未保存の変更
    // やid未発行の新規メモのままだとPiP側で更新先が無いため)、保存済みの
    // 内容からPiPウィンドウを組み立てる。
    async function handleOpenPip() {
      const memo = await handleSave();
      if (!memo) return;
      await openMemoPiP(memo);
    }

    refreshList();
    loadEditor(null);
  }

  // ---------------------------------------------------------------- Memo PiP (常時最前面表示)
  // Document Picture-in-Picture APIで、ブラウザの外にある別アプリ(MSFSを
  // ウィンドウ表示/ボーダーレス全画面で起動している場合など)の上にも
  // 常に浮かせておける、OSレベルの「常に最前面」ウィンドウを開く。
  // - 対応ブラウザはChromium系(Chrome/Edge)のみ(2026年9月時点でSafari/
  //   Firefoxは非対応)。非対応ブラウザではトーストで案内して終了する。
  // - MSFSが「排他的フルスクリーン」モードの場合、OSのウィンドウ合成自体が
  //   バイパスされるため、このウィンドウを含めどんなウィンドウも上に出せ
  //   ない。ウィンドウモード/ボーダーレスウィンドウにする必要がある。
  // - PiPウィンドウは独立したトップレベルウィンドウだが、そこに追加した
  //   要素へ張ったイベントリスナーは呼び出し元(このページ)のJSスコープで
  //   動く。api()/toast()等の共通ヘルパーをそのまま使えるのはそのため。
  // - 同一オリジンのstyles.cssをそのまま読み込むことで、ダークテーマの
  //   配色(CSS変数)を含めてメイン画面と同じ見た目にしている。
  // - テキスト入力・手書き(ストローク終了時)のたびに800ms後にPUTで自動
  //   保存する。ウィンドウを閉じた瞬間(pagehide)にも最終保存を試みる。
  async function openMemoPiP(memo) {
    if (!("documentPictureInPicture" in window)) {
      toast("常時最前面表示はChromeまたはEdgeブラウザでのみ使えます（Safari/Firefoxは非対応です）。");
      return;
    }

    let pipWindow;
    try {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 340, height: 480 });
    } catch (err) {
      toast("常時最前面ウィンドウを開けませんでした。");
      return;
    }

    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        if (!sheet.href) return;
        const link = pipWindow.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        pipWindow.document.head.appendChild(link);
      } catch { /* クロスオリジンのシートは読めないのでスキップ */ }
    });
    pipWindow.document.title = "メモ（常時表示）";
    pipWindow.document.body.className = "memo-pip-body";
    pipWindow.document.body.innerHTML = `
      <div class="memo-pip">
        <div class="memo-pip-toolbar">
          <input type="color" id="pip-pen-color" value="#1a2233" title="ペンの色" />
          <input type="range" id="pip-pen-size" min="1" max="16" value="3" title="太さ" />
          <button type="button" class="btn btn-ghost memo-tool-btn" id="pip-eraser-btn" title="消しゴム">🩹</button>
          <button type="button" class="btn btn-ghost" id="pip-clear-btn" title="全消去">🗑️</button>
        </div>
        <div class="memo-pip-canvas-wrap"><canvas id="pip-canvas" class="memo-canvas"></canvas></div>
        <textarea id="pip-text" class="memo-text-input memo-pip-text" maxlength="${MEMO_TEXT_MAX}" placeholder="テキストメモ">${escapeHtml(memo.textContent || "")}</textarea>
        <div class="memo-pip-status" id="pip-status">${escapeHtml(memo.title || "無題のメモ")} ・ 自動保存</div>
      </div>
    `;

    const drawTool = { color: "#1a2233", size: 3, eraser: false };
    let canvasCtx = null;
    let hasDrawing = !!memo.drawingData;
    let drawing = false;
    let lastPoint = null;
    let saveTimer = null;

    function setStatus(text) {
      const el = pipWindow.document.getElementById("pip-status");
      if (el) el.textContent = text;
    }

    function scheduleSave() {
      setStatus("保存中…");
      if (saveTimer) pipWindow.clearTimeout(saveTimer);
      saveTimer = pipWindow.setTimeout(doSave, 800);
    }

    async function doSave() {
      const textEl = pipWindow.document.getElementById("pip-text");
      if (!textEl) return; // ウィンドウが既に閉じられている
      const drawingData = canvasCtx && hasDrawing ? canvasCtx.canvas.toDataURL("image/png") : null;
      try {
        const { memo: updated } = await api(`/api/memos/${memo.id}`, {
          method: "PUT",
          body: JSON.stringify({ textContent: textEl.value, drawingData }),
        });
        setStatus(`${updated.title} ・ ${fmtTime(updated.updatedAt)}に保存`);
      } catch (err) {
        setStatus("保存に失敗しました");
      }
    }

    pipWindow.document.getElementById("pip-text").addEventListener("input", scheduleSave);
    pipWindow.document.getElementById("pip-pen-color").addEventListener("input", (e) => {
      drawTool.color = e.target.value;
      drawTool.eraser = false;
      updateEraserBtn();
    });
    pipWindow.document.getElementById("pip-pen-size").addEventListener("input", (e) => {
      drawTool.size = Number(e.target.value);
    });
    pipWindow.document.getElementById("pip-eraser-btn").addEventListener("click", () => {
      drawTool.eraser = !drawTool.eraser;
      updateEraserBtn();
    });
    pipWindow.document.getElementById("pip-clear-btn").addEventListener("click", () => {
      if (!canvasCtx) return;
      const { width, height } = canvasCtx.canvas;
      canvasCtx.save();
      canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
      canvasCtx.fillStyle = "#ffffff";
      canvasCtx.fillRect(0, 0, width, height);
      canvasCtx.restore();
      hasDrawing = false;
      scheduleSave();
    });

    function updateEraserBtn() {
      const btn = pipWindow.document.getElementById("pip-eraser-btn");
      if (btn) btn.classList.toggle("active", drawTool.eraser);
    }

    function setupPipCanvas() {
      const canvas = pipWindow.document.getElementById("pip-canvas");
      const wrap = canvas.parentElement;

      function resize() {
        const dpr = pipWindow.devicePixelRatio || 1;
        const cssWidth = wrap.clientWidth || 300;
        const cssHeight = wrap.clientHeight || 220;
        // リサイズ前の内容を退避して、サイズ変更後に描き直す(手書きが
        // 消えてしまわないように)。
        const snapshot = canvasCtx ? canvas.toDataURL("image/png") : (memo.drawingData || null);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.round(cssWidth * dpr);
        canvas.height = Math.round(cssHeight * dpr);
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, cssWidth, cssHeight);
        canvasCtx = ctx;
        if (snapshot) {
          const img = pipWindow.document.createElement("img");
          img.onload = () => ctx.drawImage(img, 0, 0, cssWidth, cssHeight);
          img.src = snapshot;
        }
      }
      resize();
      pipWindow.addEventListener("resize", resize);

      function pointFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
      function strokeWidthFor(e) {
        if (e.pointerType === "pen" && e.pressure > 0) {
          return Math.max(1, drawTool.size * e.pressure * 1.6);
        }
        return drawTool.size;
      }

      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drawing = true;
        lastPoint = pointFromEvent(e);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drawing) return;
        e.preventDefault();
        const point = pointFromEvent(e);
        canvasCtx.strokeStyle = drawTool.eraser ? "#ffffff" : drawTool.color;
        canvasCtx.lineWidth = drawTool.eraser ? drawTool.size * 3 : strokeWidthFor(e);
        canvasCtx.beginPath();
        canvasCtx.moveTo(lastPoint.x, lastPoint.y);
        canvasCtx.lineTo(point.x, point.y);
        canvasCtx.stroke();
        lastPoint = point;
        hasDrawing = true;
      });
      function endStroke(e) {
        if (!drawing) return;
        drawing = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        scheduleSave();
      }
      canvas.addEventListener("pointerup", endStroke);
      canvas.addEventListener("pointercancel", endStroke);
      canvas.addEventListener("pointerleave", endStroke);
    }

    setupPipCanvas();

    pipWindow.addEventListener("pagehide", () => {
      if (saveTimer) pipWindow.clearTimeout(saveTimer);
      doSave();
    });

    toast("常時最前面のメモウィンドウを開きました。他のアプリの上に重ねて配置できます。");
  }

  // Adds files picked via the file input, pasted from the clipboard, or
  // dropped onto the composer to the pending image list, enforcing
  // MAX_COMPOSER_IMAGES and silently skipping non-image files (e.g. if a
  // drop or paste also contains other file types).
  function addComposerFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const room = MAX_COMPOSER_IMAGES - state.composerFiles.length;
    if (room <= 0) {
      toast(`画像は最大${MAX_COMPOSER_IMAGES}枚までです。`);
      return;
    }
    const toAdd = files.slice(0, room);
    if (files.length > toAdd.length) toast(`画像は最大${MAX_COMPOSER_IMAGES}枚までです。`);
    toAdd.forEach((file) => {
      state.composerFiles.push(file);
      state.composerPreviewUrls.push(URL.createObjectURL(file));
    });
    renderComposerPreview();
  }

  function removeComposerFile(index) {
    const [url] = state.composerPreviewUrls.splice(index, 1);
    state.composerFiles.splice(index, 1);
    if (url) URL.revokeObjectURL(url);
    renderComposerPreview();
  }

  function renderComposerPreview() {
    const slot = document.getElementById("composer-preview-slot");
    if (!slot) return;
    if (!state.composerPreviewUrls.length) { slot.innerHTML = ""; return; }
    slot.innerHTML = `
      <div class="composer-preview-grid">
        ${state.composerPreviewUrls.map((url, i) => `
          <div class="composer-preview">
            <img src="${url}" alt="preview ${i + 1}" />
            <button class="remove-preview" data-remove-index="${i}">✕</button>
          </div>
        `).join("")}
      </div>
    `;
    slot.querySelectorAll("[data-remove-index]").forEach((btn) => {
      btn.addEventListener("click", () => removeComposerFile(Number(btn.dataset.removeIndex)));
    });
  }

  async function onSubmitPost() {
    const textEl = document.getElementById("composer-text");
    const text = textEl.value.trim();

    // Poll validation happens client-side too (server re-validates
    // regardless — see POST /api/posts in routes/posts.js) purely so the
    // person gets immediate feedback instead of a round-trip error.
    let poll = null;
    if (state.pendingPoll) {
      const options = state.pendingPoll.options.map((o) => o.trim()).filter(Boolean);
      if (!text) { toast("投票には質問文（本文）を入力してください。"); return; }
      if (options.length < POLL_MIN_OPTIONS) { toast(`選択肢を${POLL_MIN_OPTIONS}個以上入力してください。`); return; }
      poll = { options };
    }

    if (!text && !state.composerFiles.length && !state.pendingFlight && !poll) return;
    const btn = document.getElementById("composer-submit");
    btn.disabled = true;
    btn.textContent = "投稿中...";
    try {
      await createPost(text, state.composerFiles, state.pendingFlight, poll);
      textEl.value = "";
      state.composerPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
      state.composerFiles = [];
      state.composerPreviewUrls = [];
      document.getElementById("composer-file-input").value = "";
      renderComposerPreview();
      state.pendingFlight = null;
      renderComposerFlightPreview();
      state.pendingPoll = null;
      renderComposerPollBuilder();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "投稿";
    }
  }

  // 広告枠。中身は/api/ads/frame(routes/ads.js参照)が返す、CSPを外した
  // 独立ドキュメントをiframeで読み込む — document.write()で自身を描画する
  // 広告ネットワーク(AdMax本体のスクリプトなど)は、このアプリの通常の
  // nonce/strict-dynamic方式のCSPだと「動的に挿入されたスクリプト」としては
  // 扱われず(document.writeで挿入されたスクリプトはCSP仕様上
  // "parser-inserted"扱いになり、strict-dynamicの信頼伝播の対象外という
  // 仕様上の抜け穴)、ブロックされてしまうため。広告の実寸は広告ユニットに
  // よって変わるので、高さは固定せず/api/ads/frame側からのpostMessageで
  // 動的に調整する(下のmessageリスナー参照)。
  //
  // sandbox属性はあえて付けない。allow-scripts(スクリプト実行)と
  // allow-same-origin(自オリジン=このサイト自身としての扱い)を両方
  // 同時に付けると、フレーム内のスクリプトが自分自身のsandbox制限を
  // 実質的に無効化できてしまい、ブラウザ側から警告が出る組み合わせに
  // なる(sandboxの意味が無くなる)。かといってallow-same-originを外すと、
  // フレームは毎回別オリジン扱いになり、広告ネットワーク側のCookie/
  // ストレージに基づく処理(重複表示防止や計測など)が正しく動かなくなる
  // おそれがある。このiframeの中身は/api/ads/frameという自サイト自身の
  // ルートで、しかも管理者パネルで管理者自身が貼り付けたコードなので
  // (第三者の未知のiframeを埋め込んでいるわけではない)、sandboxで
  // 追加隔離する意味はもともと薄い。
  function adSlotHtml(slotId) {
    return `
      <div class="ad-slot" data-ad-slot-id="${slotId}">
        <span class="ad-slot-label">広告</span>
        <iframe
          class="ad-slot-frame"
          src="/api/ads/frame"
          scrolling="no"
          loading="lazy"
          title="広告"
        ></iframe>
      </div>
    `;
  }

  // /api/ads/frame内のスクリプト(routes/ads.js参照)からのpostMessageを
  // 受けて、該当iframeの高さを実寸に合わせる。event.sourceで直接どの
  // iframeからのメッセージかを判別できるので、スロットIDの受け渡しは
  // 不要。
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.source !== "aerosocial-ad-frame") return;
    const height = Math.max(50, Math.min(600, Number(event.data.height) || 0));
    if (!height) return;
    document.querySelectorAll(".ad-slot-frame").forEach((iframe) => {
      if (iframe.contentWindow === event.source) iframe.style.height = `${height}px`;
    });
  });

  function renderFeedList() {
    renderFeedStats();
    const list = document.getElementById("feed-list");
    if (!list) return;

    if (state.searchResults !== null) {
      if (state.searching) {
        list.innerHTML = `<div class="empty-state">検索中...</div>`;
        return;
      }
      const seen = new Set();
      const uniqueResults = state.searchResults.filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
      const users = state.userSearchResults || [];

      if (!users.length && !uniqueResults.length) {
        list.innerHTML = `<div class="empty-state">「${escapeHtml(state.searchQuery)}」に一致するユーザー・投稿はありません</div>`;
        return;
      }

      const usersHtml = users.length
        ? `
          <div class="search-users-section">
            <div class="search-section-title">ユーザー</div>
            <div id="search-users-list"></div>
          </div>
        `
        : "";
      const postsHtml = uniqueResults.length
        ? `
          <div class="search-section-title">投稿</div>
          ${uniqueResults.map((post) => renderPostHtml(post)).join("")}
        `
        : "";

      list.innerHTML = usersHtml + postsHtml;
      if (users.length) {
        renderFollowListRows(document.getElementById("search-users-list"), users, "");
      }
      attachFeedListeners();
      return;
    }

    if (!state.posts.length) {
      list.innerHTML = `<div class="empty-state">まだ投稿がありません。最初のフライトをシェアしよう ✈️</div>`;
      return;
    }
    // Defensive: render each post id at most once. state.posts should
    // already be unique by id, but this guarantees the feed can never show
    // the same post card twice even if a duplicate slips into the array.
    const seen = new Set();
    const uniquePosts = state.posts.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Ad code (set via admin panel -> 広告 tab, see openAdminPanelModal)
    // is spliced in after every `frequency` posts, never before the first
    // one and never past the end of the currently loaded posts. Admins
    // themselves never see ads in their own feed (state.isAdmin is
    // verified server-side — see checkAdminStatus — so this can't be
    // spoofed by a non-admin editing client state).
    const adCode = state.adConfig.enabled && !state.isAdmin ? state.adConfig.code : "";
    const adFrequency = Math.max(1, Number(state.adConfig.frequency) || 5);
    let adSlotCount = 0;
    const cardsHtml = uniquePosts.map((post, i) => {
      let html = renderPostHtml(post);
      if (adCode && (i + 1) % adFrequency === 0) {
        adSlotCount += 1;
        html += adSlotHtml(adSlotCount);
      }
      return html;
    }).join("");

    list.innerHTML = cardsHtml + renderFeedLoadMoreHtml();
    attachFeedListeners();
    const loadMoreBtn = document.getElementById("feed-load-more-btn");
    if (loadMoreBtn) loadMoreBtn.addEventListener("click", loadMoreFeed);
  }

  function renderFeedLoadMoreHtml() {
    if (!state.feedHasMore) return "";
    return `
      <div class="feed-load-more">
        <button type="button" class="btn btn-ghost" id="feed-load-more-btn" ${state.feedLoadingMore ? "disabled" : ""}>
          ${state.feedLoadingMore ? "読み込み中..." : "過去の投稿をもっと見る"}
        </button>
      </div>
    `;
  }

  // Small stat strip shown beside the feed: how many of the currently
  // loaded posts are flight logs.
  function renderFeedStats() {
    const slot = document.getElementById("feed-stats-slot");
    if (!slot) return;
    const flightCount = state.posts.filter((p) => p.type === "flight").length;
    if (!flightCount) { slot.innerHTML = ""; return; }
    slot.innerHTML = `
      <div class="feed-stats">
        <span>✈️</span> フィード内のフライト投稿 <b>${flightCount}</b> 件
      </div>
    `;
  }

  // "人気のフライト" panel: the most-liked flight-type posts, fetched
  // separately from the main feed (see loadPopularFlights). Accepts an
  // optional target element so the same renderer can also populate the
  // mobile bottom-sheet panel opened from the tab bar (see openMobilePanel).
  function renderPopularFlights(targetEl) {
    const slot = targetEl || document.getElementById("popular-flights-slot");
    if (!slot) return;
    const list = state.popularFlights || [];
    if (!list.length) {
      // In the sidebar this panel simply isn't shown yet; opened as its
      // own mobile panel it needs an explicit empty state instead of a
      // blank sheet.
      slot.innerHTML = targetEl ? `<div class="quake-empty">まだ人気のフライトはありません</div>` : "";
      return;
    }
    slot.innerHTML = `
      <div class="popular-flights">
        <div class="popular-flights-title">🏆 人気のフライト</div>
        <div class="popular-flights-list">
          ${list.map((p) => `
            <button type="button" class="popular-flight-item" data-post-id="${p.id}">
              <div class="popular-flight-route">
                ${escapeHtml(p.flight?.originIcao || "?")}<span class="flight-arrow">→</span>${escapeHtml(p.flight?.destIcao || "?")}
              </div>
              <div class="popular-flight-meta">
                ${avatarHtml({ name: p.authorName, hue: p.authorHue, avatarUrl: p.authorAvatarUrl }, 20)}
                <span>@${escapeHtml(p.authorCallsign)}</span>
                <span class="popular-flight-likes">❤️ ${p.likeCount}</span>
              </div>
            </button>
          `).join("")}
        </div>
      </div>
    `;
    slot.querySelectorAll(".popular-flight-item").forEach((el) => {
      el.addEventListener("click", () => openPostDetail(el.dataset.postId));
    });
  }

  // 「🗞️ 日本のニュース」パネル。人気のフライトパネルの下部に表示する
  // (デスクトップは #news-panel-slot、モバイルは「人気のフライト」の
  // ボトムシートの続きにappendして表示 — openMobilePanel参照)。
  // targetElを渡さない場合はデスクトップの#news-panel-slotを使い、その
  // 場合のみ丸ごと置き換える。append=trueの場合はtargetEl内に追記する
  // (モバイルのボトムシートは人気のフライトと同じ入れ物を共有するため)。
  function renderNewsPanel(targetEl, append) {
    const slot = targetEl || document.getElementById("news-panel-slot");
    if (!slot) return;
    const list = state.news || [];

    const html = !list.length
      ? (append || targetEl ? `<div class="quake-empty">まだニュースはありません</div>` : "")
      : `
        <div class="news-panel">
          <div class="news-panel-title"><span>🗞️</span> 日本のニュース</div>
          <div class="news-panel-list">
            ${list.slice(0, 20).map((n) => `
              <button type="button" class="news-item${n.isBreaking ? " news-item-breaking" : ""}" data-news-id="${escapeHtml(n.id)}">
                ${n.imageUrl
                  ? `<img class="news-item-thumb" src="${escapeHtml(n.imageUrl)}" loading="lazy" alt="" data-fallback-hue="${hueFromString(n.source || n.title)}" />`
                  : `<div class="news-item-thumb news-item-thumb-fallback" style="--news-hue:${hueFromString(n.source || n.title)}">🗞️</div>`}
                <div class="news-item-body">
                  ${n.isBreaking ? `<span class="news-badge-breaking">速報</span>` : ""}
                  <div class="news-item-title">${escapeHtml(n.title)}</div>
                  <div class="news-item-meta">
                    <span class="news-item-source">${escapeHtml(n.source || "")}</span>
                    <span>・</span>
                    <span>${fmtTime(n.publishedAt || n.createdAt)}</span>
                  </div>
                </div>
              </button>
            `).join("")}
          </div>
          <div class="news-panel-credit">Powered by Google ニュース</div>
        </div>
      `;

    if (append) {
      slot.insertAdjacentHTML("beforeend", html);
    } else {
      slot.innerHTML = html;
    }

    slot.querySelectorAll(".news-item").forEach((el) => {
      el.addEventListener("click", () => {
        const item = state.news.find((n) => n.id === el.dataset.newsId);
        if (item) openNewsDetailModal(item);
      });
    });

    // 記事から拾ってきた画像(og:image)は、ホットリンク拒否やリンク切れで
    // 読み込みに失敗することがある。失敗したらその場でフォールバック表示
    // (色付きの🗞️アイコン)に差し替える。
    slot.querySelectorAll(".news-item-thumb[data-fallback-hue]").forEach((img) => {
      img.addEventListener("error", () => swapNewsThumbToFallback(img), { once: true });
    });
  }

  function swapNewsThumbToFallback(imgEl, baseClass) {
    const hue = imgEl.dataset.fallbackHue || "28";
    const fallback = document.createElement("div");
    fallback.className = `${baseClass || "news-item-thumb"} news-item-thumb-fallback`;
    fallback.style.setProperty("--news-hue", hue);
    fallback.textContent = "🗞️";
    imgEl.replaceWith(fallback);
  }

  // ---------------------------------------------------------------- ニュースハブ（おしゃれなニュースサイト風ポップアップ）
  // トップバー/モバイルメニューの「🗞️ ニュース」ボタンから開く。既存の
  // #news-panel-slot(サイドバーの簡易リスト)とは別に、大きめのヒーロー
  // 記事+グリッドで一覧できる専用モーダルを表示する。データソースは
  // 同じstate.newsで、記事クリックは既存のopenNewsDetailModal()を再利用
  // する(本文は複製しない方針も踏襲)。
  // モーダルが開いている間だけ、loadNews()の再フェッチやWS(news:new)受信
  // のたびにrenderNewsHubBody()が中身を更新できるよう、開いている
  // overlay要素をここに保持しておく(閉じたらnullに戻す)。
  let newsHubModalEl = null;
  // カテゴリータブの選択状態("すべて"は特別扱いのnull)。モーダルを
  // 開き直すたびにリセットする(開いたまま裏でWS受信してもタブ選択は
  // 保持したいので、close()以外ではリセットしない)。
  let newsHubActiveCategory = null;

  // 記事一覧からカテゴリー一覧を作る。バックエンド(services/newsFeed.js)
  // 側のCATEGORY_RULESの並び順をなるべく尊重したいが、フロント側では
  // ルール定義そのものを持っていないので、単純に「記事が新しいものから
  // 見て初登場した順」で並べる(体感的にはだいたい自然な順序になる)。
  // category未設定(バックエンド再起動前の古い記事など)は「総合」に寄せる。
  function newsCategoryOf(n) {
    return n.category || "総合";
  }
  function collectNewsCategories(list) {
    const seen = new Set();
    for (const n of list) seen.add(newsCategoryOf(n));
    return Array.from(seen);
  }

  function newsHubImageHtml(n, imgClass) {
    if (n.imageUrl) {
      return `<img class="${imgClass}" src="${escapeHtml(n.imageUrl)}" loading="lazy" alt="" data-fallback-hue="${hueFromString(n.source || n.title)}" data-fallback-class="${imgClass}" />`;
    }
    return `<div class="${imgClass} news-item-thumb-fallback" style="--news-hue:${hueFromString(n.source || n.title)}">🗞️</div>`;
  }

  function renderNewsHubHeroHtml(n) {
    return `
      <button type="button" class="news-hub-hero${n.isBreaking ? " news-item-breaking" : ""}" data-news-id="${escapeHtml(n.id)}">
        ${newsHubImageHtml(n, "news-hub-hero-image")}
        <div class="news-hub-hero-body">
          ${n.isBreaking ? `<span class="news-badge-breaking">速報</span>` : ""}
          ${n.category ? `<span class="news-detail-category">${escapeHtml(n.category)}</span>` : ""}
          <div class="news-hub-hero-title">${escapeHtml(n.title)}</div>
          ${n.summary ? `<div class="news-hub-hero-summary">${escapeHtml(n.summary)}</div>` : ""}
          <div class="news-item-meta">
            <span class="news-item-source">${escapeHtml(n.source || "")}</span>
            <span>・</span>
            <span>${fmtTime(n.publishedAt || n.createdAt)}</span>
          </div>
        </div>
      </button>
    `;
  }

  function renderNewsHubCardHtml(n) {
    return `
      <button type="button" class="news-hub-card${n.isBreaking ? " news-item-breaking" : ""}" data-news-id="${escapeHtml(n.id)}">
        ${newsHubImageHtml(n, "news-hub-card-image")}
        <div class="news-hub-card-body">
          ${n.isBreaking ? `<span class="news-badge-breaking">速報</span>` : ""}
          ${n.category ? `<span class="news-hub-card-category">${escapeHtml(n.category)}</span>` : ""}
          <div class="news-hub-card-title">${escapeHtml(n.title)}</div>
          ${n.summary ? `<div class="news-hub-card-summary">${escapeHtml(n.summary)}</div>` : ""}
          <div class="news-item-meta">
            <span class="news-item-source">${escapeHtml(n.source || "")}</span>
            <span>・</span>
            <span>${fmtTime(n.publishedAt || n.createdAt)}</span>
          </div>
        </div>
      </button>
    `;
  }

  // グリッドに入りきらない残りは、画像なしの密なテキスト一覧として
  // 見出し+出典+時刻だけ並べる(PC版で画面の余白を情報で埋めるための
  // 「その他の見出し」欄 — 新聞サイトの下部見出しリストと同じ考え方)。
  function renderNewsHubListRowHtml(n) {
    return `
      <button type="button" class="news-hub-list-row${n.isBreaking ? " news-item-breaking" : ""}" data-news-id="${escapeHtml(n.id)}">
        ${n.isBreaking ? `<span class="news-badge-breaking">速報</span>` : ""}
        ${n.category ? `<span class="news-hub-list-row-category">${escapeHtml(n.category)}</span>` : ""}
        <span class="news-hub-list-row-title">${escapeHtml(n.title)}</span>
        <span class="news-hub-list-row-meta">
          <span class="news-item-source">${escapeHtml(n.source || "")}</span>
          <span>・</span>
          <span>${fmtTime(n.publishedAt || n.createdAt)}</span>
        </span>
      </button>
    `;
  }

  // カテゴリータブ行。「すべて」+ 記事に実際に出現しているカテゴリーの
  // みを出す(存在しないカテゴリーのタブを出しても空振りになるため)。
  function renderNewsHubTabs() {
    if (!newsHubModalEl) return;
    const tabsEl = newsHubModalEl.querySelector("#news-hub-tabs");
    if (!tabsEl) return;
    const list = state.news || [];
    const categories = collectNewsCategories(list);

    // 選んでいたカテゴリーが(記事の入れ替わりなどで)一覧から消えたら
    // 「すべて」に戻す。
    if (newsHubActiveCategory && !categories.includes(newsHubActiveCategory)) {
      newsHubActiveCategory = null;
    }

    if (categories.length <= 1) {
      // カテゴリーが1種類以下ならタブを出す意味が無いので隠す。
      tabsEl.innerHTML = "";
      tabsEl.hidden = true;
      return;
    }
    tabsEl.hidden = false;

    const allTabHtml = `
      <button type="button" class="news-hub-tab${newsHubActiveCategory ? "" : " active"}" data-news-category="">
        すべて
      </button>
    `;
    const tabsHtml = categories
      .map(
        (cat) => `
      <button type="button" class="news-hub-tab${newsHubActiveCategory === cat ? " active" : ""}" data-news-category="${escapeHtml(cat)}">
        ${escapeHtml(cat)}
      </button>
    `
      )
      .join("");
    tabsEl.innerHTML = allTabHtml + tabsHtml;

    tabsEl.querySelectorAll("[data-news-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        newsHubActiveCategory = btn.dataset.newsCategory || null;
        renderNewsHubTabs();
        renderNewsHubBody();
        // タブ切り替え時は一覧の先頭に戻す(前のカテゴリーのスクロール
        // 位置が残っていると、切り替わったことに気づきにくいため)。
        const body = newsHubModalEl.querySelector("#news-hub-body");
        if (body) body.scrollTop = 0;
      });
    });
  }

  function renderNewsHubBody() {
    if (!newsHubModalEl) return; // モーダルが開いていなければ何もしない
    const body = newsHubModalEl.querySelector("#news-hub-body");
    if (!body) return;
    const list = newsHubActiveCategory
      ? (state.news || []).filter((n) => newsCategoryOf(n) === newsHubActiveCategory)
      : state.news || [];

    if (!list.length) {
      body.innerHTML = `<div class="empty-state">${
        newsHubActiveCategory ? "このカテゴリーの記事はまだありません。" : "まだニュースはありません。"
      }</div>`;
      return;
    }

    const [hero, ...rest] = list;
    // グリッドで大きく見せる件数と、その下にテキストのみで密に並べる
    // 「その他の見出し」件数を分ける(デスクトップは画面が広い分、情報量を
    // 増やすため後者を多めに出す — 表示はCSS側でモバイルは隠さず折返す)。
    const gridItems = rest.slice(0, 11);
    const listItems = rest.slice(11, 50);
    body.innerHTML = `
      <div class="news-hub-body-inner">
        ${renderNewsHubHeroHtml(hero)}
        <div class="news-hub-grid">
          ${gridItems.map(renderNewsHubCardHtml).join("")}
        </div>
        ${listItems.length ? `
          <div class="news-hub-list-heading">その他の見出し</div>
          <div class="news-hub-list">
            ${listItems.map(renderNewsHubListRowHtml).join("")}
          </div>
        ` : ""}
      </div>
    `;

    body.querySelectorAll("[data-news-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const item = state.news.find((n) => n.id === el.dataset.newsId);
        if (item) openNewsDetailModal(item);
      });
    });
    // 記事画像の読み込み失敗時のフォールバックは、サイドバー版と同じ
    // swapNewsThumbToFallback()を再利用するが、ヒーロー画像とグリッド
    // カード画像はサイズが異なるため、要素自身のクラス(data-fallback-class)
    // をそのまま引き継いで正しいサイズのプレースホルダーにする。
    body.querySelectorAll("img[data-fallback-hue]").forEach((img) => {
      img.addEventListener("error", () => swapNewsThumbToFallback(img, img.dataset.fallbackClass), { once: true });
    });
  }

  function openNewsHubModal() {
    newsHubActiveCategory = null; // 開き直すたびに「すべて」から始める
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop news-hub-backdrop";
    overlay.innerHTML = `
      <div class="modal news-hub-modal">
        <div class="news-hub-masthead">
          <button type="button" class="news-hub-back" id="news-hub-close" aria-label="閉じる">
            <span class="news-hub-back-arrow">←</span>
          </button>
          <div class="news-hub-masthead-text">
            <div class="news-hub-masthead-title"><span>🗞️</span> AeroSocial ニュース</div>
            <div class="news-hub-masthead-sub">日本の最新ニュースをお届け</div>
          </div>
        </div>
        <div class="news-hub-tabs" id="news-hub-tabs" hidden></div>
        <div id="news-hub-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    newsHubModalEl = overlay;
    // フルスクリーン表示のモーダルを開いている間は背面がスクロールしない
    // ようにする(通常サイズのモーダルは重なりで気づきにくいが、全画面だと
    // 背面が動くと目立つため明示的に止める)。
    document.body.classList.add("news-hub-open");

    function close() {
      overlay.remove();
      newsHubModalEl = null;
      // メモを裏に開いたままニュースだけ閉じた場合に誤って背面スクロールを
      // 有効化しないよう、同種のオーバーレイが他に残っていないか確認する。
      if (!document.querySelector(".news-hub-backdrop")) {
        document.body.classList.remove("news-hub-open");
      }
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("news-hub-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    renderNewsHubTabs();
    renderNewsHubBody();
    // 開いた時点で一応最新化しておく(サイドバーと同じ理由 — 取りこぼし埋め)。
    loadNews();
  }

  // ---------------------------------------------------------------- 「メッセージ」タブ (運営からのお知らせをDM風に見る)
  // 上部バナー(showAnnouncementBar)は一過性の速報表示だが、こちらは
  // 送信履歴を1本の会話のように遡れる一覧。送信元は常に運営(=管理者が
  // POSTしたもの)なので、双方向のDMではなく片側だけの吹き出しが並ぶ形。
  let messagesModalEl = null;

  function messageBubbleHtml(m) {
    return `
      <div class="dm-message" data-id="${escapeHtml(m.id)}">
        <div class="dm-avatar" aria-hidden="true">📣</div>
        <div class="dm-bubble-col">
          <div class="dm-bubble-meta"><span class="dm-sender">運営${m.authorCallsign ? `（${escapeHtml(m.authorCallsign)}）` : ""}</span></div>
          <div class="dm-bubble">${escapeHtml(m.message)}</div>
          <div class="dm-time">${fmtTime(m.createdAt)}</div>
        </div>
      </div>
    `;
  }

  // モーダルが開いている間だけ、WS到着時にこの一覧へも即時反映する
  // (renderNewsHubBody等と同じ「開いていれば直接DOM操作」の方針)。
  function renderMessagesList() {
    if (!messagesModalEl) return;
    const body = messagesModalEl.querySelector("#messages-body");
    if (!body) return;
    const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    if (!state.messagesLoaded) {
      body.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
      return;
    }
    if (!state.messages.length) {
      body.innerHTML = `<p class="admin-empty">まだ運営からのメッセージはありません</p>`;
      return;
    }
    body.innerHTML = state.messages.map(messageBubbleHtml).join("");
    // 新着が追記された時は下端に固定し続け、過去ログを読み返している
    // 最中（下端から離れている）なら邪魔しないようスクロール位置を保つ。
    if (wasNearBottom) body.scrollTop = body.scrollHeight;
  }

  function openMessagesModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal dm-modal">
        <button class="modal-close" id="messages-close">✕</button>
        <h2>📣 運営からのメッセージ</h2>
        <div class="dm-body" id="messages-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    messagesModalEl = overlay;

    function close() {
      overlay.remove();
      messagesModalEl = null;
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("messages-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    renderMessagesList();
    // 開いた時点の最新メッセージを既読にする(未読バッジを消す)。
    markMessagesRead();
    // 最新化して開く(バナーを見逃した/初回ロード前に開いた場合の穴埋め)。
    loadMessages().then(() => {
      renderMessagesList();
      markMessagesRead();
      // 一覧を開いた直後は最新(=末尾)を見せる。
      const body = document.getElementById("messages-body");
      if (body) body.scrollTop = body.scrollHeight;
    });
  }

  // クリックした記事の詳細ポップアップ。APITube側の記事本文はここでは
  // 複製せず、要約(description)と出典・元記事へのリンクだけを見せる
  // — 出典元の著作権を尊重するため、全文はここに持ち込まない。
  function openNewsDetailModal(item) {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal news-detail-modal">
        <button class="modal-close" id="news-detail-close">✕</button>
        ${item.imageUrl ? `<img class="news-detail-image" src="${escapeHtml(item.imageUrl)}" alt="" onerror="this.remove()" />` : ""}
        <div class="news-detail-body">
          ${item.isBreaking ? `<span class="news-badge-breaking">速報</span>` : ""}
          ${item.category ? `<span class="news-detail-category">${escapeHtml(item.category)}</span>` : ""}
          <h2 class="news-detail-title">${escapeHtml(item.title)}</h2>
          <div class="news-detail-meta">${escapeHtml(item.source || "")} ・ ${fmtTime(item.publishedAt || item.createdAt)}</div>
          ${item.summary ? `<p class="news-detail-summary">${escapeHtml(item.summary)}</p>` : ""}
          <a class="btn btn-primary news-detail-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">元記事を読む ↗</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#news-detail-close").addEventListener("click", () => overlay.remove());
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
    });
  }

  // 速報(is_breaking)を「緊急地震速報」のポップアップと同じ演出
  // (画面上部からスライドイン + 自動で消える)で見せる — showEewPopup/
  // hideEewPopupと対になる、ニュース版。色味はEEW(赤)と混同しないよう
  // オレンジ系にしてある(see .news-flash-popup in styles.css)。
  let newsFlashTimer = null;

  function showNewsFlashPopup(item) {
    let el = document.getElementById("news-flash-popup");
    if (!el) {
      el = document.createElement("div");
      el.id = "news-flash-popup";
      el.className = "news-flash-popup";
      document.body.appendChild(el);
    }

    el.innerHTML = `
      <div class="news-flash-inner" id="news-flash-body">
        <div class="news-flash-title">🚨 速報</div>
        <div class="news-flash-headline">${escapeHtml(item.title)}</div>
        <div class="news-flash-source">${escapeHtml(item.source || "")}</div>
      </div>
      <button type="button" class="eew-popup-close" id="news-flash-close" aria-label="閉じる">✕</button>
    `;
    el.querySelector("#news-flash-body").addEventListener("click", () => {
      hideNewsFlashPopup();
      openNewsDetailModal(item);
    });
    el.querySelector("#news-flash-close").addEventListener("click", (e) => {
      e.stopPropagation();
      hideNewsFlashPopup();
    });

    // 同じ理由でshow/reflow/showを打ち直す(showEewPopupと同じ手法) —
    // 連続で速報が来ても毎回スライドインし直す。
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");

    if (newsFlashTimer) clearTimeout(newsFlashTimer);
    newsFlashTimer = setTimeout(hideNewsFlashPopup, 8000);
  }

  function hideNewsFlashPopup() {
    const el = document.getElementById("news-flash-popup");
    if (!el) return;
    el.classList.remove("show");
    if (newsFlashTimer) { clearTimeout(newsFlashTimer); newsFlashTimer = null; }
  }

  // Renders a post's images: a single full-width image, or a grid for
  // multiple images (2-up / 3-up with the first image tall / 4-up).
  function renderPostImages(urls) {
    if (urls.length === 1) {
      return `<img class="post-image" data-action="zoom" data-url="${escapeHtml(urls[0])}" src="${escapeHtml(urls[0])}" loading="lazy" alt="投稿画像" />`;
    }
    const gridClass = `post-image-grid-${Math.min(urls.length, 4)}`;
    return `
      <div class="post-image-grid ${gridClass}">
        ${urls.map((url, i) => `
          <img class="post-image-grid-item" data-action="zoom" data-url="${escapeHtml(url)}" src="${escapeHtml(url)}" loading="lazy" alt="投稿画像 ${i + 1}" />
        `).join("")}
      </div>
    `;
  }

  // Renders a poll's options as clickable bars once attached to a post.
  // Before the viewer has voted, options are plain buttons; after voting
  // (myVoteOptionId set), every option becomes a percentage bar with the
  // viewer's own pick highlighted — same pattern X/Twitter-style polls
  // use, so re-clicking a bar still re-votes (see attachPollListeners).
  function pollCardHtml(post) {
    const poll = post.poll;
    if (!poll) return "";
    const voted = !!poll.myVoteOptionId;
    const total = poll.totalVotes;
    return `
      <div class="poll-card" data-post-id="${post.id}">
        ${poll.options.map((opt) => {
          const pct = total > 0 ? Math.round((opt.voteCount / total) * 100) : 0;
          const mine = opt.id === poll.myVoteOptionId;
          if (!voted) {
            return `
              <button type="button" class="poll-option-btn" data-action="vote" data-option-id="${opt.id}">
                ${escapeHtml(opt.text)}
              </button>
            `;
          }
          return `
            <button type="button" class="poll-option-result ${mine ? "poll-option-mine" : ""}" data-action="vote" data-option-id="${opt.id}">
              <span class="poll-option-fill" style="width:${pct}%;"></span>
              <span class="poll-option-label">
                ${mine ? '<span class="material-symbols-rounded poll-check" aria-hidden="true">check_circle</span>' : ""}
                ${escapeHtml(opt.text)}
              </span>
              <span class="poll-option-pct">${pct}%</span>
            </button>
          `;
        }).join("")}
        <div class="poll-meta">${total}票${voted ? " · タップで投票を変更" : ""}</div>
      </div>
    `;
  }

  function renderPostHtml(post) {
    const mine = state.user && post.authorId === state.user.id;
    const isOpen = state.openComments.has(post.id);
    const comments = state.commentsByPost[post.id] || [];
    const ytId = post.text ? extractYouTubeId(post.text) : null;

    return `
      <article class="post" data-post-id="${post.id}" style="cursor:pointer;">
        <div class="post-head">
          <div class="who" data-action="view-profile" data-callsign="${escapeHtml(post.authorCallsign)}" style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; min-width:0;">
            ${avatarHtml({ name: post.authorName, hue: post.authorHue, avatarUrl: post.authorAvatarUrl }, 38)}
            <div>
              <div class="name">${escapeHtml(post.authorName)} <span style="color:var(--text-dim);font-weight:400">@${escapeHtml(post.authorCallsign)}</span></div>
              <div class="meta">${fmtTime(post.createdAt)}${post.authorFlightCount ? ` · ✈️ ${post.authorFlightCount}フライト` : ""}</div>
            </div>
          </div>
          ${mine ? `<button class="delete-btn" data-action="delete">削除</button>` : ""}
        </div>

        ${post.text ? `<div class="post-text">${linkify(escapeHtml(post.text))}</div>` : ""}

        ${ytId ? youtubeCardHtml(ytId) : ""}

        ${post.flight ? `
          <div class="flight-card flight-card-rich">
            ${flightCardHtml(post.flight)}
          </div>
        ` : ""}

        ${pollCardHtml(post)}

        ${post.imageUrls && post.imageUrls.length ? renderPostImages(post.imageUrls) : ""}

        <div class="post-actions">
          <button class="action-btn ${post.likedByMe ? "liked" : ""}" data-action="like">
            ${post.likedByMe ? "❤️" : "🤍"} ${post.likeCount}
          </button>
          <button class="action-btn" data-action="toggle-comments">💬 ${post.commentCount}</button>
          <button class="action-btn" data-action="share">🔗 共有</button>
        </div>

        ${isOpen ? `
          <div class="comments">
            ${comments.map((c) => `
              <div class="comment"><b>${escapeHtml(c.authorName || c.authorCallsign)}</b><span>${linkify(escapeHtml(c.text))}</span></div>
            `).join("")}
            <form class="comment-form" data-action="comment-form">
              <input name="text" placeholder="コメントを入力..." autocomplete="off" />
              <button type="submit">送信</button>
            </form>
          </div>
        ` : ""}
      </article>
    `;
  }

  // Attaches all interaction handlers for a single rendered post card.
  // Used for the main feed, the post-detail modal, and profile view posts.
  // `onChange`, if given, is called after any action that could change what
  // should be shown (used by the detail modal / profile view to re-render
  // themselves, since they aren't covered by the feed's own re-render).
  function attachPostListeners(el, postId, onChange) {
    const likeBtn = el.querySelector('[data-action="like"]');
    if (likeBtn) {
      likeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleLike(postId);
        if (onChange) onChange();
      });
    }

    const delBtn = el.querySelector('[data-action="delete"]');
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deletePost(postId);
        if (onChange) onChange();
      });
    }

    el.querySelectorAll('[data-action="vote"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await voteOnPoll(postId, btn.dataset.optionId);
        if (onChange) onChange();
      });
    });

    el.querySelectorAll('[data-action="zoom"]').forEach((img) => {
      img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(img.dataset.url || img.src); });
    });

    // Swap the thumbnail for a real, playing iframe only once clicked —
    // keeps the feed light (no iframes loaded per post just to scroll past).
    // Title/channel, on the other hand, load right away (they're just a
    // small JSON fetch, not a whole iframe) so the card doesn't sit with
    // shimmering placeholders any longer than necessary.
    el.querySelectorAll('[data-action="youtube-card"]').forEach((card) => {
      loadYoutubeMeta(card);
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = card.dataset.videoId;
        if (!id) return;
        card.outerHTML = `
          <div class="youtube-embed">
            <iframe
              src="https://www.youtube.com/embed/${id}?autoplay=1"
              title="YouTube video player"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
          </div>
        `;
      });
    });

    const flightCardEl = el.querySelector(".flight-card");
    if (flightCardEl) {
      flightCardEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const post = state.posts.find((p) => p.id === postId);
        if (post?.flight) openFlightDetail(post.flight);
      });
    }

    const toggleBtn = el.querySelector('[data-action="toggle-comments"]');
    if (toggleBtn) {
      toggleBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (state.openComments.has(postId)) {
          state.openComments.delete(postId);
          if (onChange) onChange();
        } else {
          state.openComments.add(postId);
          if (onChange) onChange();
          await loadComments(postId);
          if (onChange) onChange();
        }
      });
    }

    const commentForm = el.querySelector('[data-action="comment-form"]');
    if (commentForm) {
      commentForm.addEventListener("click", (e) => e.stopPropagation());
      commentForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Guards against rapid comment spam ("連投"): a submit already in
        // flight for this form (double-click, double-Enter, or a slow
        // network response) is ignored outright, and after a successful
        // post the form stays disabled for COMMENT_COOLDOWN_MS so the same
        // person can't fire off a burst of separate comments in a row.
        if (commentForm.dataset.submitting === "1") return;
        const input = commentForm.querySelector('input[name="text"]');
        const text = input.value;
        if (!text.trim()) return;

        commentForm.dataset.submitting = "1";
        const submitBtn = commentForm.querySelector('button[type="submit"]');
        input.disabled = true;
        if (submitBtn) submitBtn.disabled = true;
        input.value = "";

        try {
          await postComment(postId, text);
          if (onChange) onChange();
        } catch (err) {
          toast(err.message);
          input.value = text; // give the text back so it isn't lost on failure
        } finally {
          setTimeout(() => {
            commentForm.dataset.submitting = "";
            input.disabled = false;
            if (submitBtn) submitBtn.disabled = false;
          }, COMMENT_COOLDOWN_MS);
        }
      });
    }

    const shareBtn = el.querySelector('[data-action="share"]');
    if (shareBtn) {
      shareBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const post = state.posts.find((p) => p.id === postId);
        if (post) sharePost(post);
      });
    }

    const profileLink = el.querySelector('[data-action="view-profile"]');
    if (profileLink) {
      profileLink.addEventListener("click", (e) => {
        e.stopPropagation();
        openUserProfile(profileLink.dataset.callsign);
      });
    }
  }

  function attachFeedListeners() {
    document.querySelectorAll("#feed-list .post").forEach((el) => {
      const postId = el.dataset.postId;
      attachPostListeners(el, postId, renderFeedList);
      el.addEventListener("click", (e) => {
        if (e.target.closest("button, a, input, form")) return;
        openPostDetail(postId);
      });
    });
  }

  // ---------------------------------------------------------------- post detail
  function openPostDetail(postId) {
    const post = state.posts.find((p) => p.id === postId);
    if (!post) return;
    state.openComments.add(postId);

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal" style="max-width:520px;">
        <button class="modal-close" id="detail-close">✕</button>
        <div id="detail-post-slot"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("detail-close").addEventListener("click", () => overlay.remove());

    function renderDetail() {
      if (!document.body.contains(overlay)) return;
      if (!state.posts.some((p) => p.id === postId)) { overlay.remove(); return; }
      const slot = document.getElementById("detail-post-slot");
      if (!slot) return;
      slot.innerHTML = renderPostHtml(post);
      attachPostListeners(slot.querySelector(".post"), postId, renderDetail);
    }

    renderDetail();
    if (!state.commentsByPost[postId]) loadComments(postId).then(renderDetail);
  }

  // ---------------------------------------------------------------- other users' profiles
  // Renders `users` as a clickable list of rows (avatar/name/callsign) into
  // `container`. Clicking a row opens that user's own profile popup.
  function renderFollowListRows(container, users, emptyMessage) {
    if (!users.length) {
      container.innerHTML = `<div style="color:var(--text-dim); font-size:13px;">${emptyMessage}</div>`;
      return;
    }
    container.innerHTML = users.map((u) => `
      <div class="follow-list-row" data-callsign="${escapeHtml(u.callsign)}" style="display:flex; align-items:center; gap:10px; padding:8px 0; cursor:pointer; border-bottom:1px solid var(--border);">
        ${avatarHtml(u, 32)}
        <div style="min-width:0;">
          <div style="font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(u.name)}</div>
          <div style="color:var(--text-dim); font-size:12px;">@${escapeHtml(u.callsign)}</div>
        </div>
      </div>
    `).join("");
    container.querySelectorAll(".follow-list-row").forEach((row) => {
      row.addEventListener("click", () => openUserProfile(row.dataset.callsign));
    });
  }

  // Fetches `callsign`'s followers/following list and renders it into
  // `container` (a spinner is shown first). `isStale()`, if given, lets the
  // caller bail out if the container's purpose changed (panel closed or
  // switched to the other list) while the request was still in flight.
  async function loadFollowList(container, callsign, kind, isStale) {
    container.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
    try {
      const { users } = await api(`/api/users/${encodeURIComponent(callsign)}/${kind}`);
      if (isStale && isStale()) return;
      renderFollowListRows(
        container,
        users,
        kind === "followers" ? "まだフォロワーがいません。" : "まだ誰もフォローしていません。"
      );
    } catch (err) {
      if (isStale && isStale()) return;
      container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  // プロフィールの「好きなアニメ」タブに複数件並べる。各タイトルごとに
  // 専用のスロットを作り、renderAnimeCard()にそのまま渡す(1件ずつ独立
  // して非同期にWikipedia/Jikanへ問い合わせるので、遅い1件が他のカード
  // の表示をブロックしない)。タブのラベル自体が見出しを兼ねるので、
  // ここでは中身(カードのリスト)だけを描画する。
  function renderAnimeSidebar(container, titles) {
    if (!container) return;
    const list = (titles || []).filter(Boolean);
    if (!list.length) {
      container.innerHTML = `<div class="empty-state">好きなアニメが登録されていません。</div>`;
      return;
    }
    container.innerHTML = list.map((_, i) => `<div id="anime-card-slot-${i}"></div>`).join("");
    list.forEach((title, i) => {
      const slot = container.querySelector(`#anime-card-slot-${i}`);
      if (slot) renderAnimeCard(slot, title);
    });
  }

  // ---------------------------------------------------------------- favorite anime card
  // Looks up `title` on Japanese Wikipedia and renders a small card (cover
  // image + あらすじ excerpt) into `container`. Everything here talks
  // directly to Wikipedia's public APIs from the browser — both endpoints
  // below are CORS-enabled (the REST summary endpoint always is; the
  // legacy action API needs the `origin=*` query param) — so no backend
  // proxy is needed. Fails silently (falls back to a plain title/link)
  // since a missing/renamed anime page shouldn't break the whole profile.
  async function renderAnimeCard(container, title) {
    container.innerHTML = `
      <div class="anime-card">
        <div class="anime-card-body">
          <div class="anime-card-label">好きなアニメ</div>
          <div class="anime-card-title">${escapeHtml(title)}</div>
          <div class="anime-card-loading">Wikipediaから情報を取得中...</div>
        </div>
      </div>
    `;

    try {
      // 1. Resolve the user's freeform text to an actual Wikipedia page
      // title (handles typos/partial titles/redirected names).
      const searchRes = await fetch(
        `https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=1&srsearch=${encodeURIComponent(title)}`
      );
      const searchData = await searchRes.json();
      const hit = searchData?.query?.search?.[0];
      const pageTitle = hit ? hit.title : title;
      const pageUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;

      // 2. Cover image + a lead-extract fallback, via the REST summary
      // endpoint (always CORS-enabled, no origin param needed).
      let image = null;
      let fallbackExtract = "";
      try {
        const summaryRes = await fetch(
          `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`
        );
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          image = summaryData.originalimage?.source || summaryData.thumbnail?.source || null;
          fallbackExtract = summaryData.extract || "";
        }
      } catch { /* image/extract are optional, page link + title still render */ }

      // 2b. Wikipediaに画像が無かった場合のフォールバック: Jikan API
      // (MyAnimeList)からカバー画像を取得(自前のバックエンド経由 —
      // routes/animeImage.js参照)。ここも失敗しても致命的ではないので
      // 黙って諦め、画像無しのカードとして表示する。
      if (!image) {
        try {
          const fallbackImageRes = await fetch(`/api/anime-image?q=${encodeURIComponent(pageTitle)}`);
          if (fallbackImageRes.ok) {
            const fallbackImageData = await fallbackImageRes.json();
            if (fallbackImageData.image) image = fallbackImageData.image;
          }
        } catch { /* no image at all is fine, card still renders without one */ }
      }

      // 3. The actual あらすじ section, if the page has one — anime/manga
      // articles almost always do, but the lead extract above is a
      // reasonable stand-in when they don't.
      let synopsis = fallbackExtract;
      try {
        const sectionsRes = await fetch(
          `https://ja.wikipedia.org/w/api.php?action=parse&format=json&origin=*&prop=sections&page=${encodeURIComponent(pageTitle)}`
        );
        const sectionsData = await sectionsRes.json();
        const section = sectionsData?.parse?.sections?.find((s) => s.line === "あらすじ" || s.line === "概要");
        if (section) {
          const textRes = await fetch(
            `https://ja.wikipedia.org/w/api.php?action=parse&format=json&origin=*&prop=text&page=${encodeURIComponent(pageTitle)}&section=${section.index}`
          );
          const textData = await textRes.json();
          const html = textData?.parse?.text?.["*"] || "";
          const plain = html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, "")
            .replace(/\[\d+\]/g, "")
            .replace(/\s+\n/g, "\n")
            .trim();
          if (plain) synopsis = plain;
        }
      } catch { /* fall back to fallbackExtract set above */ }

      container.innerHTML = `
        <div class="anime-card${image ? " anime-card--has-image" : ""}">
          ${image ? `<img class="anime-card-bg-image" src="${escapeHtml(image)}" alt="" aria-hidden="true" />` : ""}
          ${image ? `<div class="anime-card-overlay"></div>` : ""}
          <div class="anime-card-body">
            <div class="anime-card-label">好きなアニメ</div>
            <div class="anime-card-title"><a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pageTitle)}</a></div>
            ${synopsis ? `<div class="anime-card-synopsis">${escapeHtml(synopsis)}</div>` : ""}
          </div>
        </div>
      `;
    } catch {
      // Network/lookup failure: still show the title the user entered,
      // just without image/synopsis, rather than an empty gap.
      container.innerHTML = `
        <div class="anime-card">
          <div class="anime-card-body">
            <div class="anime-card-label">好きなアニメ</div>
            <div class="anime-card-title">${escapeHtml(title)}</div>
          </div>
        </div>
      `;
    }
  }

  // ---------------------------------------------------------------- shared stat/chart widgets
  // Used by the profile's ログブック/実績 tabs and the ランキング modal.
  // Reuses the same visual language (and CSS classes) as the admin panel's
  // own stat cards / bar rows / line chart (see openAdminPanelModal ->
  // statCard() / renderPostsLineChart() below) — promoted up here as
  // shared, non-admin-specific helpers instead of copy-pasting a second
  // near-identical implementation.
  function statCardHtml(label, value) {
    return `<div class="admin-stat-card"><div class="admin-stat-value">${escapeHtml(String(value))}</div><div class="admin-stat-label">${escapeHtml(label)}</div></div>`;
  }

  function barRowHtml(label, value, displayValue, maxValue) {
    const pct = maxValue > 0 ? Math.round((value / maxValue) * 100) : 0;
    return `
      <div class="admin-bar-row">
        <div class="admin-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="admin-bar-track"><div class="admin-bar-fill" style="width:${pct}%"></div></div>
        <div class="admin-bar-value">${escapeHtml(displayValue)}</div>
      </div>
    `;
  }

  // Lightweight hand-rolled SVG line chart — no charting library dependency
  // for what's just a single series of ~12 points. `points` is any array;
  // valueFn/labelFn/tooltipFn read whatever's needed out of each point.
  function renderLineChart(points, { valueFn, labelFn, tooltipFn, ariaLabel }) {
    if (!points.length) return `<p class="empty-state">データがありません。</p>`;
    const width = 600;
    const height = 180;
    const padTop = 16;
    const padBottom = 26;
    const padX = 8;
    const maxValue = Math.max(1, ...points.map(valueFn));
    const plotHeight = height - padTop - padBottom;
    const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
    const xAt = (i) => padX + stepX * i;
    const yAt = (v) => padTop + plotHeight - (v / maxValue) * plotHeight;
    const pts = points.map((p, i) => ({ p, x: xAt(i), y: yAt(valueFn(p)) }));

    const linePath = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(height - padBottom).toFixed(1)} `
      + `L${pts[0].x.toFixed(1)},${(height - padBottom).toFixed(1)} Z`;

    const gridLines = [0, 0.5, 1].map((f) => {
      const y = padTop + plotHeight - f * plotHeight;
      return `
        <line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}" class="admin-linechart-grid" />
        <text x="0" y="${(y + 3).toFixed(1)}" class="admin-linechart-axis-label">${Math.round(f * maxValue).toLocaleString()}</text>
      `;
    }).join("");

    const labelEvery = pts.length > 20 ? 5 : pts.length > 8 ? 2 : 1;
    const xLabels = pts.map((pt, i) => {
      if (i % labelEvery !== 0 && i !== pts.length - 1) return "";
      return `<text x="${pt.x.toFixed(1)}" y="${height - 8}" class="admin-linechart-axis-label" text-anchor="middle">${escapeHtml(labelFn(pt.p))}</text>`;
    }).join("");

    const dots = pts.map((pt) => `
      <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.5" class="admin-linechart-dot">
        <title>${escapeHtml(tooltipFn(pt.p))}</title>
      </circle>
    `).join("");

    return `
      <svg viewBox="0 0 ${width} ${height}" class="admin-linechart" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel || "")}">
        ${gridLines}
        <path d="${areaPath}" class="admin-linechart-area" />
        <path d="${linePath}" class="admin-linechart-line" />
        ${dots}
        ${xLabels}
      </svg>
    `;
  }

  // ---------------------------------------------------------------- logbook tab (profile)
  const LOGBOOK_METRICS = {
    distanceNm: { label: "距離", fmt: (v) => `${Math.round(v).toLocaleString()}nm` },
    hours: { label: "時間", fmt: (v) => `${v.toFixed(1)}h` },
    flights: { label: "フライト数", fmt: (v) => `${Math.round(v).toLocaleString()}件` },
  };

  async function renderLogbookTab(container, callsign) {
    container.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
    let data;
    try {
      data = await api(`/api/users/${encodeURIComponent(callsign)}/logbook`);
    } catch (err) {
      container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      return;
    }

    let metric = "distanceNm";

    function monthlyChartHtml() {
      const def = LOGBOOK_METRICS[metric];
      return renderLineChart(data.monthly, {
        valueFn: (m) => m[metric],
        labelFn: (m) => { const [y, mo] = m.month.split("-"); return `${y.slice(2)}/${mo}`; },
        tooltipFn: (m) => `${m.month}: ${def.fmt(m[metric])}`,
        ariaLabel: "月別の飛行実績推移",
      });
    }

    function aircraftHtml() {
      if (!data.aircraft.length) return `<div class="empty-state">まだフライト記録がありません。</div>`;
      const top = data.aircraft.slice(0, 8);
      const maxHours = Math.max(...top.map((a) => a.hours), 1);
      return `<div class="admin-bar-chart">${top
        .map((a) => barRowHtml(a.name || a.icao || "不明", a.hours, `${a.hours.toFixed(1)}h`, maxHours))
        .join("")}</div>`;
    }

    function airportsHtml() {
      if (!data.airports.length) return `<div class="empty-state">まだフライト記録がありません。</div>`;
      const shown = data.airports.slice(0, 15);
      return `
        <div class="logbook-airport-list">
          ${shown.map((a) => `
            <div class="logbook-airport-row">
              <div class="logbook-airport-icao">${escapeHtml(a.icao)}</div>
              <div class="logbook-airport-name">${escapeHtml(a.name || "")}</div>
              <div class="logbook-airport-visits">${a.visits}回</div>
            </div>
          `).join("")}
        </div>
        ${data.airportCount > shown.length ? `<div class="logbook-more-note">ほか${data.airportCount - shown.length}空港</div>` : ""}
      `;
    }

    function recentHtml() {
      if (!data.recentFlights.length) return `<div class="empty-state">まだフライト記録がありません。</div>`;
      return `
        <div class="logbook-recent-list">
          ${data.recentFlights.map((f) => `
            <div class="logbook-recent-row" data-post-id="${escapeHtml(f.postId)}">
              <div class="logbook-recent-route">${escapeHtml(f.originIcao || "????")} → ${escapeHtml(f.destIcao || "????")}</div>
              <div class="logbook-recent-meta">${escapeHtml(f.aircraftName || f.aircraftIcao || "機材不明")}${f.distanceNm != null ? ` ・ ${f.distanceNm}nm` : ""}</div>
              <div class="logbook-recent-date">${fmtTime(f.createdAt)}</div>
            </div>
          `).join("")}
        </div>
      `;
    }

    function render() {
      const t = data.totals;
      container.innerHTML = `
        <div class="admin-stat-grid">
          ${statCardHtml("総フライト数", t.flights.toLocaleString())}
          ${statCardHtml("総飛行時間", `${t.hours.toFixed(1)}h`)}
          ${statCardHtml("総飛行距離", `${Math.round(t.distanceNm).toLocaleString()}nm`)}
          ${statCardHtml("就航空港数", data.airportCount.toLocaleString())}
        </div>

        <div class="admin-section-title-row" style="margin-top:20px;">
          <h4 style="margin:0; font-size:14px;">月別の推移</h4>
          <div class="admin-toggle-group" id="logbook-metric-toggle">
            ${Object.entries(LOGBOOK_METRICS).map(([key, def]) => `
              <button type="button" data-metric="${key}" class="${key === metric ? "active" : ""}">${def.label}</button>
            `).join("")}
          </div>
        </div>
        <div class="admin-linechart-wrap" id="logbook-chart-wrap">${monthlyChartHtml()}</div>

        <h4 style="margin:20px 0 10px; font-size:14px;">機材別の飛行時間</h4>
        ${aircraftHtml()}

        <h4 style="margin:20px 0 10px; font-size:14px;">就航空港</h4>
        ${airportsHtml()}

        <h4 style="margin:20px 0 10px; font-size:14px;">最近のフライト</h4>
        ${recentHtml()}
      `;

      container.querySelectorAll("#logbook-metric-toggle button").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.metric === metric) return;
          metric = btn.dataset.metric;
          container.querySelectorAll("#logbook-metric-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
          container.querySelector("#logbook-chart-wrap").innerHTML = monthlyChartHtml();
        });
      });
      container.querySelectorAll(".logbook-recent-row").forEach((row) => {
        row.addEventListener("click", () => openPostDetail(row.dataset.postId));
      });
    }

    render();
  }

  // ---------------------------------------------------------------- achievements tab (profile)
  const ACHIEVEMENT_CATEGORY_LABELS = {
    flights: "フライト数",
    hours: "飛行時間",
    distance: "飛行距離",
    airports: "就航空港数",
    landmark: "到着空港",
  };

  async function renderAchievementsTab(container, callsign) {
    container.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
    let data;
    try {
      data = await api(`/api/users/${encodeURIComponent(callsign)}/achievements`);
    } catch (err) {
      container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      return;
    }

    const byCategory = new Map();
    data.achievements.forEach((a) => {
      if (!byCategory.has(a.category)) byCategory.set(a.category, []);
      byCategory.get(a.category).push(a);
    });

    function badgeCardHtml(a) {
      const progress = a.target
        ? `<div class="admin-bar-track badge-progress-track"><div class="admin-bar-fill" style="width:${Math.round((a.current / a.target) * 100)}%"></div></div>`
        : "";
      return `
        <div class="badge-card${a.earned ? " earned" : ""}">
          <div class="badge-icon">${a.icon}</div>
          <div class="badge-label">${escapeHtml(a.label)}</div>
          <div class="badge-description">${escapeHtml(a.description)}</div>
          ${progress}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="admin-stat-grid admin-stat-grid-2" style="margin-bottom:20px;">
        ${statCardHtml("達成済み", `${data.earnedCount} / ${data.totalCount}`)}
        ${statCardHtml("達成率", `${Math.round((data.earnedCount / data.totalCount) * 100)}%`)}
      </div>
      ${Array.from(byCategory.entries()).map(([category, list]) => `
        <h4 style="margin:20px 0 10px; font-size:14px;">${escapeHtml(ACHIEVEMENT_CATEGORY_LABELS[category] || category)}</h4>
        <div class="badge-grid">${list.map(badgeCardHtml).join("")}</div>
      `).join("")}
    `;
  }

  // ---------------------------------------------------------------- leaderboard (ランキング)
  // Public, everyone-can-see ranking by distance/hours/flights, this month
  // or all-time — distinct from the admin panel's own stats tab (which is
  // admin-only and about the platform as a whole). See
  // GET /api/logbook/leaderboard (routes/logbook.js).
  const LEADERBOARD_METRIC_FMT = {
    distance: (e) => `${Math.round(e.distanceNm).toLocaleString()}nm`,
    hours: (e) => `${e.hours.toFixed(1)}h`,
    flights: (e) => `${e.flights.toLocaleString()}件`,
  };

  function leaderboardRowHtml(entry, fmt, isMe) {
    const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;
    return `
      <div class="leaderboard-row${isMe ? " is-me" : ""}" data-callsign="${escapeHtml(entry.user.callsign)}">
        <div class="leaderboard-rank">${medal || `#${entry.rank}`}</div>
        ${avatarHtml(entry.user, 32)}
        <div class="leaderboard-name">
          <div class="leaderboard-display-name">${escapeHtml(entry.user.name)}</div>
          <div class="leaderboard-callsign">@${escapeHtml(entry.user.callsign)}</div>
        </div>
        <div class="leaderboard-value">${fmt(entry)}</div>
      </div>
    `;
  }

  function openLeaderboardModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop mobile-sheet-backdrop";
    overlay.innerHTML = `
      <div class="modal profile-modal">
        <button class="modal-close" id="leaderboard-close">✕</button>
        <h2 style="font-size:16px;">🏆 ランキング</h2>
        <div class="admin-section-title-row" style="margin-top:0;">
          <div class="admin-toggle-group" id="leaderboard-period-toggle">
            <button type="button" data-period="month" class="active">今月</button>
            <button type="button" data-period="all">全期間</button>
          </div>
          <div class="admin-toggle-group" id="leaderboard-metric-toggle">
            <button type="button" data-metric="distance" class="active">距離</button>
            <button type="button" data-metric="hours">時間</button>
            <button type="button" data-metric="flights">フライト数</button>
          </div>
        </div>
        <div id="leaderboard-body"><div class="spinner-row">読み込み中...</div></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#leaderboard-close").addEventListener("click", () => overlay.remove());

    let period = "month";
    let metric = "distance";

    function renderBody(data) {
      const body = overlay.querySelector("#leaderboard-body");
      const fmt = LEADERBOARD_METRIC_FMT[metric];
      if (!data.entries.length) {
        body.innerHTML = `<div class="empty-state">まだフライト記録がありません。</div>`;
        return;
      }
      const meInTop = data.me && data.entries.some((e) => e.user.callsign === data.me.user.callsign);
      body.innerHTML = `
        <div class="leaderboard-list">
          ${data.entries.map((e) => leaderboardRowHtml(e, fmt, state.user && e.user.callsign === state.user.callsign)).join("")}
        </div>
        ${data.me && !meInTop ? `
          <div class="leaderboard-me-divider">あなたの順位</div>
          <div class="leaderboard-list">${leaderboardRowHtml(data.me, fmt, true)}</div>
        ` : ""}
      `;
      body.querySelectorAll(".leaderboard-row").forEach((row) => {
        row.addEventListener("click", () => openUserProfile(row.dataset.callsign));
      });
    }

    async function load() {
      const body = overlay.querySelector("#leaderboard-body");
      body.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
      try {
        const data = await api(`/api/logbook/leaderboard?period=${period}&metric=${metric}&limit=20`);
        renderBody(data);
      } catch (err) {
        body.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      }
    }

    overlay.querySelectorAll("#leaderboard-period-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.period === period) return;
        period = btn.dataset.period;
        overlay.querySelectorAll("#leaderboard-period-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
        load();
      });
    });
    overlay.querySelectorAll("#leaderboard-metric-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.metric === metric) return;
        metric = btn.dataset.metric;
        overlay.querySelectorAll("#leaderboard-metric-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
        load();
      });
    });

    load();
  }

  // Profile popup: a fixed header (avatar/name/bio/flight stats) followed
  // by a tab bar — 投稿 / フォロワー / フォロー中 / (あれば)好きなアニメ —
  // switching a single content area. Each tab's content is fetched once,
  // the first time it's opened, and then just shown/hidden after that.
  async function openUserProfile(callsign) {
    const overlay = document.createElement("div");
    // mobile-sheet-backdrop: below 900px this makes the profile popup slide
    // up as a bottom sheet (like the quake/menu panels) instead of sitting
    // as a small centered card — easier to reach one-handed and the close
    // button lands in a predictable spot instead of floating mid-screen.
    // Desktop is untouched (see .mobile-sheet-backdrop in styles.css).
    overlay.className = "modal-backdrop mobile-sheet-backdrop";
    overlay.innerHTML = `
      <div class="modal profile-modal">
        <button class="modal-close" id="profile-view-close">✕</button>
        <div class="profile-header-banner"></div>
        <div id="profile-view-slot"><div class="spinner-row">読み込み中...</div></div>
        <div id="profile-tabs" class="profile-tabs" hidden></div>
        <div id="profile-tab-posts" class="profile-tab-panel"></div>
        <div id="profile-tab-logbook" class="profile-tab-panel" hidden></div>
        <div id="profile-tab-achievements" class="profile-tab-panel" hidden></div>
        <div id="profile-tab-followers" class="profile-tab-panel" hidden></div>
        <div id="profile-tab-following" class="profile-tab-panel" hidden></div>
        <div id="profile-tab-anime" class="profile-tab-panel" hidden></div>
      </div>
    `;
    document.body.appendChild(overlay);
    const profileModalEl = overlay.querySelector(".profile-modal");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#profile-view-close").addEventListener("click", () => overlay.remove());

    let activeTab = "posts";
    const loadedTabs = new Set();
    // Actual per-tab loaders are assigned once `user`/`posts` are known,
    // below — this indirection just lets showTab() be wired up before
    // that data arrives.
    let loadTabContent = () => {};

    function showTab(tab) {
      activeTab = tab;
      overlay.querySelectorAll(".profile-tab-panel").forEach((el) => {
        el.hidden = el.id !== `profile-tab-${tab}`;
      });
      overlay.querySelectorAll(".profile-tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
      });
      loadTabContent(tab);
    }

    try {
      const [{ user, stats, follow }, { posts }] = await Promise.all([
        api(`/api/users/${encodeURIComponent(callsign)}`),
        api(`/api/posts?author=${encodeURIComponent(callsign)}&limit=30`),
      ]);

      // Merge into the shared post list so like/comment/detail actions on
      // these posts behave exactly like posts from the main feed.
      posts.forEach((p) => {
        const idx = state.posts.findIndex((existing) => existing.id === p.id);
        if (idx === -1) state.posts.push(p);
        else state.posts[idx] = p;
      });

      // Own profile never shows a follow button against yourself.
      const isOwnProfile = state.user && state.user.callsign === user.callsign;
      let followState = { followerCount: follow.followerCount, isFollowedByMe: follow.isFollowedByMe };
      const followingCount = follow.followingCount;
      const animeList = (user.favoriteAnimeList || []).filter(Boolean);

      const slot = overlay.querySelector("#profile-view-slot");
      if (!slot) return;

      function renderFollowButton() {
        if (isOwnProfile) return "";
        return `
          <button
            class="btn ${followState.isFollowedByMe ? "btn-ghost" : "btn-primary"}"
            data-action="toggle-follow"
          >${followState.isFollowedByMe ? "フォロー解除" : "フォローする"}</button>
        `;
      }

      slot.innerHTML = `
        <div class="profile-header-top">
          <div class="profile-header-avatar-wrap">${avatarHtml(user)}</div>
          <div class="profile-header-info">
            <div class="profile-header-name">${escapeHtml(user.name)}</div>
            <div class="profile-header-handle">@${escapeHtml(user.callsign)}${user.homeBase ? ` · ${escapeHtml(user.homeBase)}` : ""}</div>
          </div>
          <div id="profile-follow-btn-slot" class="profile-header-follow-slot">${renderFollowButton()}</div>
        </div>
        ${user.bio ? `<div class="profile-header-bio">${linkify(escapeHtml(user.bio))}</div>` : ""}
        <div class="profile-header-stats">
          <div class="profile-header-stat"><b>${stats.flights}</b>フライト</div>
          <div class="profile-header-stat"><b>${stats.hours.toFixed(1)}</b>時間</div>
          <div class="profile-header-stat"><b>${Math.round(stats.distanceNm)}</b>nm</div>
        </div>
      `;
      if (profileModalEl) {
        profileModalEl.style.setProperty("--profile-hue", Number.isFinite(user.hue) ? user.hue : 200);
      }

      const followBtn = slot.querySelector("#profile-follow-btn-slot");
      if (followBtn) {
        followBtn.addEventListener("click", async (e) => {
          const btn = e.target.closest('[data-action="toggle-follow"]');
          if (!btn) return;
          if (!state.token) { toast("フォローするにはログインしてください。"); return; }
          btn.disabled = true;
          try {
            const result = await api(`/api/users/${encodeURIComponent(user.callsign)}/follow`, { method: "POST" });
            followState = { followerCount: result.followerCount, isFollowedByMe: result.following };
            followBtn.innerHTML = renderFollowButton();
            const tabBtn = overlay.querySelector('[data-tab="followers"]');
            if (tabBtn) tabBtn.textContent = `フォロワー ${followState.followerCount}`;
            // フォロー状態が変われば、開いているフォロワー一覧にも自分の
            // 有無が反映されるはずなので、表示中ならキャッシュを捨てて
            // 再取得する。
            if (loadedTabs.has("followers")) {
              loadedTabs.delete("followers");
              if (activeTab === "followers") loadTabContent("followers");
            }
          } catch (err) {
            toast(err.message);
          } finally {
            btn.disabled = false;
          }
        });
      }

      // ---- タブバー: 投稿 / フォロワー / フォロー中 / (あれば)好きなアニメ
      const tabsEl = overlay.querySelector("#profile-tabs");
      const tabDefs = [
        { id: "posts", label: "投稿" },
        { id: "logbook", label: "📊 ログブック" },
        { id: "achievements", label: "🏆 実績" },
        { id: "followers", label: `フォロワー ${followState.followerCount}` },
        { id: "following", label: `フォロー中 ${followingCount}` },
      ];
      if (animeList.length) tabDefs.push({ id: "anime", label: "🎬 好きなアニメ" });
      tabsEl.hidden = false;
      tabsEl.innerHTML = tabDefs.map((t) => `
        <button type="button" class="profile-tab-btn${t.id === "posts" ? " active" : ""}" data-tab="${t.id}">${escapeHtml(t.label)}</button>
      `).join("");
      tabsEl.querySelectorAll(".profile-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => showTab(btn.dataset.tab));
      });
      if (!animeList.length) overlay.querySelector("#profile-tab-anime").hidden = true;

      // ---- 各タブの中身
      const postIds = posts.map((p) => p.id);
      function renderProfilePosts() {
        const postsSlot = overlay.querySelector("#profile-tab-posts");
        if (!postsSlot) return;
        const current = postIds.map((id) => state.posts.find((p) => p.id === id)).filter(Boolean);
        if (!current.length) {
          postsSlot.innerHTML = `<div class="empty-state">まだ投稿がありません。</div>`;
          return;
        }
        postsSlot.innerHTML = current.map(renderPostHtml).join("");
        postsSlot.querySelectorAll(".post").forEach((el) => {
          const postId = el.dataset.postId;
          attachPostListeners(el, postId, renderProfilePosts);
          el.addEventListener("click", (e) => {
            if (e.target.closest("button, a, input, form")) return;
            openPostDetail(postId);
          });
        });
      }

      loadTabContent = function loadTabContent(tab) {
        if (loadedTabs.has(tab)) return;
        loadedTabs.add(tab);
        if (tab === "posts") renderProfilePosts();
        else if (tab === "logbook") {
          renderLogbookTab(overlay.querySelector("#profile-tab-logbook"), callsign);
        } else if (tab === "achievements") {
          renderAchievementsTab(overlay.querySelector("#profile-tab-achievements"), callsign);
        } else if (tab === "followers") {
          loadFollowList(overlay.querySelector("#profile-tab-followers"), callsign, "followers", () => activeTab !== "followers");
        } else if (tab === "following") {
          loadFollowList(overlay.querySelector("#profile-tab-following"), callsign, "following", () => activeTab !== "following");
        } else if (tab === "anime") {
          renderAnimeSidebar(overlay.querySelector("#profile-tab-anime"), animeList);
        }
      };

      loadTabContent("posts");
    } catch (err) {
      const slot = overlay.querySelector("#profile-view-slot");
      if (slot) slot.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- flight detail popup
  // A closer, briefing-style look at a flight card — as if pulling the
  // flight plan up on SimBrief itself — opened by clicking any flight card
  // (in a post, the composer preview, or the SimBrief import modal).
  function flightDetailHtml(f, hasMap) {
    const originIcao = escapeHtml(f.originIcao || "????");
    const destIcao = escapeHtml(f.destIcao || "????");
    const subtitle = [f.originName, f.destName].filter(Boolean).map(escapeHtml).join("  →  ");

    const rows = [];
    if (f.callsign) rows.push(["コールサイン", escapeHtml(f.callsign)]);
    if (f.aircraftName || f.aircraftIcao) rows.push(["機材", escapeHtml(f.aircraftName || f.aircraftIcao)]);
    if (f.distance != null) rows.push(["距離", `${f.distance} nm`]);
    if (f.durMin != null) {
      const h = Math.floor(f.durMin / 60);
      const m = Math.round(f.durMin % 60);
      rows.push(["飛行時間", `${h}時間${String(m).padStart(2, "0")}分`]);
    }
    if (f.cruiseAlt != null) rows.push(["巡航高度", `FL${Math.round(f.cruiseAlt / 100)}`]);
    if (f.eta) {
      const etaDate = new Date(f.eta);
      if (!Number.isNaN(etaDate.getTime())) {
        const etaStr = etaDate.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        rows.push(["到着予定 (ETA)", etaStr]);
      }
    }
    if (f.altIcao || f.altName) {
      rows.push(["代替空港", escapeHtml([f.altIcao, f.altName].filter(Boolean).join(" – "))]);
    }

    return `
      <div class="flight-detail">
        <div class="flight-detail-tag">🧾 フライトプラン</div>
        <div class="flight-detail-route"><b>${originIcao}</b><span class="flight-arrow">✈</span><b>${destIcao}</b></div>
        ${subtitle ? `<div class="flight-subtitle">${subtitle}</div>` : ""}
        ${hasMap ? `<div class="flight-detail-map" id="flight-detail-map"></div>` : ""}
        ${typeof f.route === "string" && f.route ? `<div class="flight-detail-route-box">${escapeHtml(f.route)}</div>` : ""}
        ${rows.length ? `
          <div class="flight-detail-grid">
            ${rows.map(([label, value]) => `
              <div class="flight-detail-row">
                <span class="flight-detail-label">${label}</span>
                <span class="flight-detail-value">${value}</span>
              </div>
            `).join("")}
          </div>
        ` : ""}
        <button type="button" class="btn btn-primary btn-block" id="flight-detail-fullscreen-btn" style="margin-top:16px;">📋 詳細を表示</button>
      </div>
    `;
  }

  // Draws the origin/destination route on a Leaflet + OpenStreetMap map
  // inside the #flight-detail-map element. Only called when both endpoints'
  // coordinates are available (older posts / SimBrief responses that never
  // carried lat/lon just skip the map and show the text card only).
  // scrollWheelZoom is left off so an accidental mouse-wheel scroll over the
  // popup can't hijack zoom instead of closing/scrolling the modal.
  // Builds the ordered lat/lon path for a flight: origin -> navlog
  // waypoints (already ordered along the route by SimBrief) -> destination.
  // Falls back to a direct origin->destination line when no waypoint data
  // is available (e.g. posts created before waypoint support existed, or a
  // flight without a filed route).
  function flightPath(f) {
    const originPt = [f.originLat, f.originLon];
    const destPt = [f.destLat, f.destLon];
    const mid = (f.waypoints || [])
      .filter((wp) => wp.lat != null && wp.lon != null)
      .map((wp) => [wp.lat, wp.lon]);
    return [originPt, ...mid, destPt];
  }

  // Adds the initial Esri basemap tile layer to `map` plus a small button
  // (top-right, alongside the zoom control) that cycles through
  // BASEMAP_STYLES (街道地図 → 地形図 → 衛星写真 → …) on click. Shared by
  // every Leaflet map in this file that should offer a style switch
  // (initFlightDetailMap, initFullscreenMap, …) so the behavior/appearance
  // stays identical everywhere instead of being copy-pasted per map.
  // Styled entirely via inline styles (not styles.css) because Leaflet's
  // own CSS (.leaflet-bar a) forces a fixed 26x26px white box on any <a>
  // inside a .leaflet-bar container, which clips/whites-out a text label
  // like "衛星写真" — inline styles win regardless of stylesheet load
  // order or caching, so the label is never at the mercy of that.
  function addBasemapLayerWithSwitch(map) {
    let styleIndex = 0;
    let baseLayer = L.tileLayer(BASEMAP_STYLES[styleIndex].url, {
      maxZoom: TILE_MAX_ZOOM,
      attribution: BASEMAP_STYLES[styleIndex].attribution,
    }).addTo(map);

    // "layers" icon (stacked squares) — a generic, style-agnostic symbol
    // for "switch basemap", so the button doesn't need to resize for each
    // style's label text.
    const LAYERS_ICON_SVG = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
        <polyline points="2 17 12 22 22 17"></polyline>
        <polyline points="2 12 12 17 22 12"></polyline>
      </svg>`;

    // Placed bottom-left (not top-right, which the fullscreen view's own
    // ✕ close button already occupies) so it never overlaps that button.
    const StyleSwitchControl = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar map-style-switch");
        const btn = L.DomUtil.create("a", "map-style-switch-btn", container);
        btn.href = "#";
        btn.innerHTML = LAYERS_ICON_SVG;
        btn.style.cssText = [
          "display:flex", "align-items:center", "justify-content:center",
          "width:30px", "height:30px", "background:#1a2338", "color:#e8ecf4",
          "border:1px solid #2c374e", "border-radius:4px",
          "text-decoration:none", "box-sizing:border-box",
        ].join(";");
        const render = () => { btn.title = `地図の種類を切り替え（現在: ${BASEMAP_STYLES[styleIndex].label}）`; };
        render();
        L.DomEvent.on(btn, "mouseover", () => { btn.style.background = "#232f4a"; });
        L.DomEvent.on(btn, "mouseout", () => { btn.style.background = "#1a2338"; });
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          styleIndex = (styleIndex + 1) % BASEMAP_STYLES.length;
          const next = BASEMAP_STYLES[styleIndex];
          map.removeLayer(baseLayer);
          baseLayer = L.tileLayer(next.url, { maxZoom: TILE_MAX_ZOOM, attribution: next.attribution }).addTo(map);
          baseLayer.bringToBack();
          render();
        });
        L.DomEvent.disableClickPropagation(container);
        return container;
      },
    });
    map.addControl(new StyleSwitchControl());
    return baseLayer;
  }

  function initFlightDetailMap(f) {
    const mapEl = document.getElementById("flight-detail-map");
    if (!mapEl) return null;
    const originPt = [f.originLat, f.originLon];
    const destPt = [f.destLat, f.destLon];

    const map = L.map(mapEl, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
    addBasemapLayerWithSwitch(map);

    const line = L.polyline(flightPath(f), { color: "#4da3ff", weight: 3 }).addTo(map);

    (f.waypoints || []).forEach((wp) => {
      if (wp.lat == null || wp.lon == null) return;
      const label = wp.altitude != null ? `${wp.ident} · FL${Math.round(wp.altitude / 100)}` : wp.ident;
      L.circleMarker([wp.lat, wp.lon], { radius: 3, color: "#4da3ff", weight: 1, fillColor: "#0e1626", fillOpacity: 1 })
        .addTo(map).bindTooltip(label || "", { permanent: false });
    });

    L.circleMarker(originPt, { radius: 7, color: "#7ee7c7", weight: 2, fillColor: "#7ee7c7", fillOpacity: 1 })
      .addTo(map).bindTooltip(f.originIcao || "出発", { permanent: false });
    L.circleMarker(destPt, { radius: 7, color: "#ff6b7a", weight: 2, fillColor: "#ff6b7a", fillOpacity: 1 })
      .addTo(map).bindTooltip(f.destIcao || "到着", { permanent: false });

    map.fitBounds(line.getBounds(), { padding: [28, 28] });
    return map;
  }

  function openFlightDetail(flight) {
    if (!flight) return;
    const hasMap = typeof L !== "undefined"
      && flight.originLat != null && flight.originLon != null
      && flight.destLat != null && flight.destLon != null;

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal flight-detail-modal">
        <button class="modal-close" id="flight-detail-close">✕</button>
        ${flightDetailHtml(flight, hasMap)}
      </div>
    `;
    document.body.appendChild(overlay);

    // initFlightDetailMap needs the #flight-detail-map element to already
    // be in the DOM (Leaflet measures its size on init), so this runs only
    // after appendChild above.
    const map = hasMap ? initFlightDetailMap(flight) : null;

    document.getElementById("flight-detail-fullscreen-btn").addEventListener("click", () => openFlightFullscreen(flight));

    function close() {
      if (map) map.remove();
      overlay.remove();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("flight-detail-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  function fsField(label, value) {
    return `<div><div class="fs-field-label">${label}</div><div class="fs-field-value">${value}</div></div>`;
  }

  // Draws the same route on a larger map for the full-screen view, using
  // boxed ICAO-code labels (like a real OFP map) instead of plain dots.
  function initFullscreenMap(f) {
    const mapEl = document.getElementById("flight-fullscreen-map");
    if (!mapEl) return null;
    const originPt = [f.originLat, f.originLon];
    const destPt = [f.destLat, f.destLon];

    const map = L.map(mapEl, { zoomControl: true, attributionControl: true });
    addBasemapLayerWithSwitch(map);

    const line = L.polyline(flightPath(f), { color: "#4da3ff", weight: 3, dashArray: "2 8" }).addTo(map);

    // Intermediate route fixes (navlog waypoints) as small labelled dots —
    // boxed ICAO labels are reserved for the origin/destination below so
    // the map doesn't get too busy on long routes with many fixes.
    (f.waypoints || []).forEach((wp) => {
      if (wp.lat == null || wp.lon == null) return;
      const label = wp.altitude != null ? `${wp.ident} · FL${Math.round(wp.altitude / 100)}` : wp.ident;
      L.circleMarker([wp.lat, wp.lon], { radius: 4, color: "#4da3ff", weight: 1.5, fillColor: "#0e1626", fillOpacity: 1 })
        .addTo(map).bindTooltip(label || "", { permanent: false });
    });

    const labelIcon = (text) => L.divIcon({
      className: "fs-airport-label",
      html: escapeHtml(text || "?"),
      iconSize: null,
    });
    L.marker(originPt, { icon: labelIcon(f.originIcao) }).addTo(map);
    L.marker(destPt, { icon: labelIcon(f.destIcao) }).addTo(map);
    if (f.altLat != null && f.altLon != null) {
      L.marker([f.altLat, f.altLon], { icon: labelIcon(f.altIcao ? `ALT ${f.altIcao}` : "ALT") }).addTo(map);
    }

    map.fitBounds(line.getBounds(), { padding: [60, 60] });
    // The map container's size right after insertion can be measured as 0
    // in some layout timings, which leaves Leaflet's tiles blank until the
    // next resize; a short delayed invalidateSize() fixes that reliably.
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  // Full-screen SimBrief-briefing-style view: an info sidebar (flight info,
  // flight plan summary, full route) plus a large route map, opened from
  // the "詳細を表示" button on the compact flight detail popup.
  function openFlightFullscreen(f) {
    const hasMap = typeof L !== "undefined"
      && f.originLat != null && f.originLon != null
      && f.destLat != null && f.destLon != null;

    const infoRows = [];
    if (f.callsign) infoRows.push(fsField("Callsign", escapeHtml(f.callsign)));
    if (f.aircraftName || f.aircraftIcao) infoRows.push(fsField("Aircraft", escapeHtml(f.aircraftName || f.aircraftIcao)));
    if (f.durMin != null) {
      const h = Math.floor(f.durMin / 60);
      const m = Math.round(f.durMin % 60);
      infoRows.push(fsField("Air Time", `${h}h ${String(m).padStart(2, "0")}m`));
    }
    if (f.eta) {
      const etaDate = new Date(f.eta);
      if (!Number.isNaN(etaDate.getTime())) {
        const etaStr = etaDate.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        infoRows.push(fsField("Arrival (ETA)", etaStr));
      }
    }
    if (f.altIcao || f.altName) {
      infoRows.push(fsField("Alternate", escapeHtml([f.altIcao, f.altName].filter(Boolean).join(" – "))));
    }
    if (f.paxCount != null) infoRows.push(fsField("Pax", String(f.paxCount)));

    const summaryRows = [];
    if (f.distance != null) summaryRows.push(fsField("Route Distance", `${f.distance} nm`));
    if (f.cruiseAlt != null) summaryRows.push(fsField("Cruise Altitude", `FL${Math.round(f.cruiseAlt / 100)}`));

    // Fuel plan and weights — units come from SimBrief's own OFP (lbs or
    // kgs depending on the pilot's profile settings).
    const fuelUnit = (f.fuelUnit || "lbs").toUpperCase();
    const fuelRows = [];
    if (f.blockFuel != null) fuelRows.push(fsField("Block Fuel", `${Math.round(f.blockFuel).toLocaleString()} ${fuelUnit}`));
    if (f.tripFuel != null) fuelRows.push(fsField("Trip Fuel", `${Math.round(f.tripFuel).toLocaleString()} ${fuelUnit}`));
    if (f.taxiFuel != null) fuelRows.push(fsField("Taxi Fuel", `${Math.round(f.taxiFuel).toLocaleString()} ${fuelUnit}`));
    if (f.reserveFuel != null) fuelRows.push(fsField("Reserve Fuel", `${Math.round(f.reserveFuel).toLocaleString()} ${fuelUnit}`));
    if (f.altFuel != null) fuelRows.push(fsField("Alternate Fuel", `${Math.round(f.altFuel).toLocaleString()} ${fuelUnit}`));

    const weightRows = [];
    if (f.estZfw != null) weightRows.push(fsField("ZFW", `${Math.round(f.estZfw).toLocaleString()} ${fuelUnit}`));
    if (f.estTow != null) weightRows.push(fsField("TOW", `${Math.round(f.estTow).toLocaleString()} ${fuelUnit}`));
    if (f.estLdw != null) weightRows.push(fsField("LDW", `${Math.round(f.estLdw).toLocaleString()} ${fuelUnit}`));

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop flight-fullscreen-backdrop";
    overlay.innerHTML = `
      <div class="flight-fullscreen">
        <button class="flight-fullscreen-close" id="fs-close">✕</button>
        <div class="flight-fullscreen-sidebar">
          <div class="flight-fullscreen-title">${escapeHtml(f.originIcao || "????")}<span class="flight-arrow">→</span>${escapeHtml(f.destIcao || "????")}</div>
          <div class="flight-fullscreen-subtitle">${[f.originName, f.destName].filter(Boolean).map(escapeHtml).join("  →  ")}</div>

          ${infoRows.length ? `
            <div class="fs-section">
              <div class="fs-section-title">Flight Info</div>
              <div class="fs-grid">${infoRows.join("")}</div>
            </div>
          ` : ""}

          ${summaryRows.length ? `
            <div class="fs-section">
              <div class="fs-section-title">Flight Plan Summary</div>
              <div class="fs-grid">${summaryRows.join("")}</div>
            </div>
          ` : ""}

          ${fuelRows.length ? `
            <div class="fs-section">
              <div class="fs-section-title">Fuel Plan</div>
              <div class="fs-grid">${fuelRows.join("")}</div>
            </div>
          ` : ""}

          ${weightRows.length ? `
            <div class="fs-section">
              <div class="fs-section-title">Weights</div>
              <div class="fs-grid">${weightRows.join("")}</div>
            </div>
          ` : ""}

          ${typeof f.route === "string" && f.route ? `
            <div class="fs-section">
              <div class="fs-section-title">Route</div>
              <div class="fs-route-box">${escapeHtml(f.route)}</div>
              <button type="button" class="btn btn-ghost fs-copy-btn" id="fs-copy-btn">📋 ルートをコピー</button>
            </div>
          ` : ""}

          ${f.waypoints && f.waypoints.length ? `
            <div class="fs-section">
              <div class="fs-section-title">Navlog (${f.waypoints.length} fixes)</div>
              <div class="fs-navlog">
                ${f.waypoints.map((wp) => `
                  <div class="fs-navlog-row">
                    <span class="fs-navlog-ident">${escapeHtml(wp.ident || "?")}</span>
                    <span class="fs-navlog-alt">${wp.altitude != null ? `FL${Math.round(wp.altitude / 100)}` : ""}</span>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}
        </div>
        <div class="flight-fullscreen-map" id="flight-fullscreen-map">
          ${hasMap ? "" : `<div class="empty-state">この投稿には地図データがありません</div>`}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const map = hasMap ? initFullscreenMap(f) : null;

    const copyBtn = document.getElementById("fs-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard?.writeText(typeof f.route === "string" ? f.route : "")
          .then(() => toast("ルートをコピーしました"))
          .catch(() => toast("コピーに失敗しました"));
      });
    }

    function close() {
      if (map) map.remove();
      overlay.remove();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("fs-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  // ---------------------------------------------------------------- lightbox
  function openLightbox(url) {
    const overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.innerHTML = `
      <button class="close-btn" id="lightbox-close">✕</button>
      <img src="${url}" alt="拡大画像" />
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.id === "lightbox-close") overlay.remove();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
    });
    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------- profile modal
  function openNotificationSettingsModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-close" id="notif-close">✕</button>
        <h2>設定</h2>
        <div class="field" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <label style="margin:0;">プッシュ通知を有効にする</label>
          <input type="checkbox" id="notif-push-toggle" ${state.pushSubscribed ? "checked" : ""} style="width:20px; height:20px;" />
        </div>
        <div class="field">
          <label>投稿の通知対象</label>
          <select id="notif-post-pref" ${state.pushSubscribed ? "" : "disabled"}>
            <option value="all" ${state.notifyPref === "all" ? "selected" : ""}>すべてのユーザーの投稿</option>
            <option value="following" ${state.notifyPref === "following" ? "selected" : ""}>フォロー中のユーザーのみ</option>
          </select>
        </div>
        <p style="font-size:12px; color:#888; margin-top:4px;">
          フォローされたときの通知は、プッシュ通知が有効な場合は常に届きます。
        </p>

        <div class="field" style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
          <label>FSAパイロットID</label>
          <div style="display:flex; gap:8px;">
            <input type="text" id="fsa-pilot-id-input" placeholder="例: 12345" style="flex:1;" />
            <button type="button" id="fsa-pilot-id-save" class="btn-secondary">保存</button>
          </div>
          <p style="font-size:12px; color:#888; margin-top:4px;">
            Flight Stream Assistant（FSA）でのあなたのパイロットIDを登録すると、以下の自動投稿の対象になります。
            分からない場合は <code>node scripts/resolve-fsa-pilot-id.js</code> で調べられます。
          </p>
        </div>

        <div class="field" style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:16px;">
          <label style="margin:0;">FSAで離陸したら自動投稿する</label>
          <input type="checkbox" id="fsa-autopost-toggle" style="width:20px; height:20px;" disabled />
        </div>
        <p style="font-size:12px; color:#888; margin-top:4px;">
          Flight Stream Assistant（FSA）で実際に離陸したことを検知すると、自動でAeroSocialにフライトカードを投稿します。
        </p>
        <p id="fsa-autopost-error" class="error-banner" style="display:none;"></p>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("notif-close").addEventListener("click", () => overlay.remove());

    const toggle = document.getElementById("notif-push-toggle");
    const prefSelect = document.getElementById("notif-post-pref");
    const fsaToggle = document.getElementById("fsa-autopost-toggle");
    const fsaError = document.getElementById("fsa-autopost-error");
    const fsaPilotIdInput = document.getElementById("fsa-pilot-id-input");
    const fsaPilotIdSaveBtn = document.getElementById("fsa-pilot-id-save");

    // FSAパイロットID: GET/PATCH /api/settings/fsa-pilot-id (see
    // routes/fsaBridgeSettings.js). ユーザーごとに1つ登録でき、ブリッジ
    // (scripts/fsa-to-aerosocial-bridge.js) はこのIDを持つ全ユーザーを
    // 対象に自動投稿する。
    (async () => {
      try {
        const { pilotId } = await api("/api/settings/fsa-pilot-id");
        fsaPilotIdInput.value = pilotId || "";
      } catch (err) {
        fsaError.textContent = `FSAパイロットIDの取得に失敗しました: ${err.message}`;
        fsaError.style.display = "block";
      }
    })();

    fsaPilotIdSaveBtn.addEventListener("click", async () => {
      fsaPilotIdSaveBtn.disabled = true;
      fsaError.style.display = "none";
      const pilotId = fsaPilotIdInput.value.trim();
      try {
        const data = await api("/api/settings/fsa-pilot-id", {
          method: "PATCH",
          body: JSON.stringify({ pilotId: pilotId || null }),
        });
        fsaPilotIdInput.value = data.pilotId || "";
        toast(pilotId ? "FSAパイロットIDを保存しました" : "FSAパイロットIDの登録を解除しました");
      } catch (err) {
        fsaError.textContent = `保存に失敗しました: ${err.message}`;
        fsaError.style.display = "block";
      } finally {
        fsaPilotIdSaveBtn.disabled = false;
      }
    });

    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      if (toggle.checked) {
        const ok = await enablePush();
        toggle.checked = ok;
        prefSelect.disabled = !ok;
        if (ok) toast("プッシュ通知を有効にしました");
      } else {
        await disablePush();
        prefSelect.disabled = true;
        toast("プッシュ通知を無効にしました");
      }
      toggle.disabled = false;
    });

    prefSelect.addEventListener("change", async () => {
      prefSelect.disabled = true;
      const previous = state.notifyPref;
      try {
        await api("/api/notifications/settings", {
          method: "PATCH",
          body: JSON.stringify({ postNotify: prefSelect.value }),
        });
        state.notifyPref = prefSelect.value;
        toast("通知設定を保存しました");
      } catch (err) {
        prefSelect.value = previous;
        toast(err.message);
      } finally {
        prefSelect.disabled = false;
      }
    });

    // FSA auto-post toggle: GET/PATCH /api/settings/fsa-auto-post (see
    // routes/settings.js). Fetched fresh every time this modal opens rather
    // than cached in state, since it can also be flipped from the separate
    // /fsa-settings.html page.
    (async () => {
      try {
        const { enabled } = await api("/api/settings/fsa-auto-post");
        fsaToggle.checked = !!enabled;
        fsaToggle.disabled = false;
      } catch (err) {
        fsaError.textContent = `FSA設定の取得に失敗しました: ${err.message}`;
        fsaError.style.display = "block";
      }
    })();

    fsaToggle.addEventListener("change", async () => {
      fsaToggle.disabled = true;
      fsaError.style.display = "none";
      const enabled = fsaToggle.checked;
      try {
        await api("/api/settings/fsa-auto-post", {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        });
        toast(enabled ? "FSA自動投稿をONにしました" : "FSA自動投稿をOFFにしました");
      } catch (err) {
        fsaToggle.checked = !enabled;
        fsaError.textContent = `保存に失敗しました: ${err.message}`;
        fsaError.style.display = "block";
      } finally {
        fsaToggle.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- events (イベント機能)
  // A single modal covers both the browsable list (upcoming/past tabs) and
  // the create form (toggled inline within the same modal, same on/off
  // pattern as pendingPoll in the composer). Clicking an event card opens
  // its detail (participant list) in a second, stacked popup — the same
  // "second modal on top" pattern used elsewhere in this file.
  function eventTypeLabel(eventType) {
    return eventType === "flight" ? "✈️ フライト" : "🎉 イベント";
  }

  function eventWhenWhereLine(ev) {
    if (ev.eventType === "flight") {
      const route = [ev.departureIcao, ev.arrivalIcao].filter(Boolean).join(" → ");
      return route || "空港未定";
    }
    return ev.location || "場所未定";
  }

  function eventCapacityLabel(ev) {
    return ev.capacity != null ? `${ev.participantCount} / ${ev.capacity}人` : `${ev.participantCount}人`;
  }

  function eventCardHtml(ev) {
    const full = ev.capacity != null && ev.participantCount >= ev.capacity && !ev.isJoined;
    return `
      <div class="event-card" data-event-id="${ev.id}">
        <div class="event-card-top">
          <span class="event-type-badge">${eventTypeLabel(ev.eventType)}</span>
          <span class="event-card-when">${fmtEventDateTime(ev.startsAt)}</span>
        </div>
        <div class="event-card-title">${escapeHtml(ev.title)}</div>
        <div class="event-card-meta">
          <span>📍 ${escapeHtml(eventWhenWhereLine(ev))}</span>
          <span>👥 ${eventCapacityLabel(ev)}</span>
        </div>
        <div class="event-card-bottom">
          <span class="event-card-creator">${avatarHtml({ name: ev.creatorName, callsign: ev.creatorCallsign, hue: ev.creatorHue, avatarUrl: ev.creatorAvatarUrl }, 20)} ${escapeHtml(ev.creatorCallsign)}</span>
          <button type="button" class="btn ${ev.isJoined ? "btn-ghost" : "btn-primary"} event-join-btn" data-event-id="${ev.id}" data-joined="${ev.isJoined ? "1" : "0"}" style="padding:5px 12px; font-size:12px;" ${full ? "disabled" : ""}>
            ${ev.isJoined ? "参加中 ✓" : (full ? "満員" : "参加する")}
          </button>
        </div>
      </div>
    `;
  }

  function openEventsModal() {
    const evState = {
      tab: "upcoming",
      events: [],
      loading: false,
      error: "",
      showCreateForm: false,
    };

    const overlay = document.createElement("div");
    // See the same mobile-sheet-backdrop comment in openUserProfile() above.
    overlay.className = "modal-backdrop mobile-sheet-backdrop";
    overlay.innerHTML = `
      <div class="modal events-modal">
        <button class="modal-close" id="events-close">✕</button>
        <h2>📅 イベント</h2>
        <div class="tabs">
          <button type="button" data-tab="upcoming" class="active">開催予定</button>
          <button type="button" data-tab="past">過去のイベント</button>
        </div>
        <div style="margin:12px 0;">
          <button type="button" class="btn btn-primary btn-block" id="event-create-toggle">+ イベントを作成</button>
        </div>
        <div id="event-create-slot"></div>
        <div id="event-list-slot"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("events-close").addEventListener("click", () => overlay.remove());

    overlay.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        evState.tab = btn.dataset.tab;
        overlay.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        loadEvents();
      });
    });

    const listSlot = document.getElementById("event-list-slot");
    const createSlot = document.getElementById("event-create-slot");

    async function loadEvents() {
      evState.loading = true;
      evState.error = "";
      renderList();
      try {
        const { events } = await api(`/api/events?scope=${evState.tab}`);
        evState.events = events;
      } catch (err) {
        evState.error = err.message;
      } finally {
        evState.loading = false;
        renderList();
      }
    }

    function renderList() {
      if (evState.loading) {
        listSlot.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
        return;
      }
      if (evState.error) {
        listSlot.innerHTML = `<div class="error-banner">${escapeHtml(evState.error)}</div>`;
        return;
      }
      if (!evState.events.length) {
        listSlot.innerHTML = `<div class="empty-state">${evState.tab === "upcoming" ? "開催予定のイベントはまだありません。" : "過去のイベントはありません。"}</div>`;
        return;
      }
      listSlot.innerHTML = evState.events.map(eventCardHtml).join("");

      listSlot.querySelectorAll(".event-join-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.dataset.eventId;
          const joined = btn.dataset.joined === "1";
          btn.disabled = true;
          try {
            await api(`/api/events/${id}/${joined ? "leave" : "join"}`, { method: "POST" });
            await loadEvents();
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
          }
        });
      });

      listSlot.querySelectorAll(".event-card").forEach((card) => {
        card.addEventListener("click", () => openEventDetail(card.dataset.eventId, loadEvents));
      });
    }

    // ---------------- create form ----------------
    const createState = { eventType: "general", capacityEnabled: false };

    function renderCreateForm() {
      if (!evState.showCreateForm) {
        createSlot.innerHTML = "";
        return;
      }
      const defaultStart = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1日後をデフォルト表示
      defaultStart.setMinutes(0, 0, 0);

      createSlot.innerHTML = `
        <form id="event-create-form" class="event-create-form">
          <div class="field">
            <label>種別</label>
            <div style="display:flex; gap:16px;">
              <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
                <input type="radio" name="event-type" value="general" ${createState.eventType === "general" ? "checked" : ""} style="width:auto;" />
                🎉 一般イベント（オフ会・配信など）
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
                <input type="radio" name="event-type" value="flight" ${createState.eventType === "flight" ? "checked" : ""} style="width:auto;" />
                ✈️ 集合フライト
              </label>
            </div>
          </div>
          <div class="field">
            <label>タイトル</label>
            <input type="text" id="event-title" maxlength="${TITLE_MAX_LEN_CLIENT}" required placeholder="例: 週末オフ会 / 羽田→新千歳 集合フライト" />
          </div>
          <div class="field">
            <label>説明（任意）</label>
            <textarea id="event-description" rows="3" maxlength="2000" placeholder="内容や集合方法など"></textarea>
          </div>
          <div class="field" id="event-location-field">
            <label>場所（任意）</label>
            <input type="text" id="event-location" maxlength="100" placeholder="例: Discordボイスチャット / YouTube Live" />
          </div>
          <div class="field" id="event-route-field" style="display:none;">
            <label>出発 / 到着空港（任意・ICAOコード）</label>
            <div style="display:flex; gap:8px;">
              <input type="text" id="event-departure" maxlength="10" placeholder="例: RJTT" style="text-transform:uppercase;" />
              <input type="text" id="event-arrival" maxlength="10" placeholder="例: RJCC" style="text-transform:uppercase;" />
            </div>
          </div>
          <div class="field" style="display:flex; gap:12px;">
            <div style="flex:1;">
              <label>開催日時</label>
              <input type="datetime-local" id="event-starts-at" required value="${toDateTimeLocalValue(defaultStart)}" />
            </div>
            <div style="flex:1;">
              <label>終了日時（任意）</label>
              <input type="datetime-local" id="event-ends-at" />
            </div>
          </div>
          <div class="field" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="event-capacity-toggle" style="width:auto;" />
            <label style="margin:0; font-weight:400;">定員を設定する</label>
            <input type="number" id="event-capacity" min="1" max="500" value="10" style="max-width:100px; margin-left:8px;" disabled />
          </div>
          <div class="field" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="event-notify-discord" style="width:auto;" />
            <label style="margin:0; font-weight:400;">Discordに通知する</label>
          </div>
          <p id="event-create-error" class="error-banner" style="display:none;"></p>
          <button type="submit" class="btn btn-primary btn-block" id="event-create-submit">作成する</button>
        </form>
      `;

      const typeRadios = createSlot.querySelectorAll('input[name="event-type"]');
      const locationField = document.getElementById("event-location-field");
      const routeField = document.getElementById("event-route-field");
      function syncTypeFields() {
        const isFlight = createState.eventType === "flight";
        locationField.style.display = isFlight ? "none" : "";
        routeField.style.display = isFlight ? "" : "none";
      }
      syncTypeFields();
      typeRadios.forEach((r) => {
        r.addEventListener("change", () => {
          createState.eventType = r.value;
          syncTypeFields();
        });
      });

      const capacityToggle = document.getElementById("event-capacity-toggle");
      const capacityInput = document.getElementById("event-capacity");
      capacityToggle.addEventListener("change", () => {
        capacityInput.disabled = !capacityToggle.checked;
      });

      document.getElementById("event-create-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById("event-create-error");
        errorEl.style.display = "none";
        const submitBtn = document.getElementById("event-create-submit");
        submitBtn.disabled = true;

        const startsAtLocal = document.getElementById("event-starts-at").value;
        const endsAtLocal = document.getElementById("event-ends-at").value;
        const body = {
          eventType: createState.eventType,
          title: document.getElementById("event-title").value,
          description: document.getElementById("event-description").value,
          startsAt: startsAtLocal ? new Date(startsAtLocal).toISOString() : "",
          endsAt: endsAtLocal ? new Date(endsAtLocal).toISOString() : null,
          notifyDiscord: document.getElementById("event-notify-discord").checked,
          capacity: capacityToggle.checked ? Number(capacityInput.value) : null,
        };
        if (createState.eventType === "flight") {
          body.departureIcao = document.getElementById("event-departure").value;
          body.arrivalIcao = document.getElementById("event-arrival").value;
        } else {
          body.location = document.getElementById("event-location").value;
        }

        try {
          await api("/api/events", { method: "POST", body: JSON.stringify(body) });
          toast("イベントを作成しました");
          evState.showCreateForm = false;
          renderCreateForm();
          evState.tab = "upcoming";
          overlay.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "upcoming"));
          loadEvents();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
        } finally {
          submitBtn.disabled = false;
        }
      });
    }

    document.getElementById("event-create-toggle").addEventListener("click", (e) => {
      evState.showCreateForm = !evState.showCreateForm;
      e.target.textContent = evState.showCreateForm ? "− 閉じる" : "+ イベントを作成";
      renderCreateForm();
    });

    loadEvents();
  }

  // Kept in sync with TITLE_MAX_LEN in src/routes/events.js — purely a UX
  // nicety (maxlength on the input), the server re-validates regardless.
  const TITLE_MAX_LEN_CLIENT = 100;

  // Detail popup for a single event: participant list + delete (own/admin
  // only). `onChange` is called after a join/leave/delete so the list
  // behind it can refresh its counts.
  function openEventDetail(eventId, onChange) {
    const popup = document.createElement("div");
    popup.className = "modal-backdrop";
    popup.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <button class="modal-close" id="event-detail-close">✕</button>
        <div id="event-detail-body"><div class="spinner-row">読み込み中...</div></div>
      </div>
    `;
    document.body.appendChild(popup);
    popup.addEventListener("click", (e) => { if (e.target === popup) popup.remove(); });
    document.getElementById("event-detail-close").addEventListener("click", () => popup.remove());

    const body = document.getElementById("event-detail-body");

    async function load() {
      try {
        const { event: ev, participants } = await api(`/api/events/${eventId}`);
        const participantsHtml = participants.length
          ? participants.map((p) => `
              <div class="event-participant-row">
                ${avatarHtml(p, 24)}
                <span>${escapeHtml(p.callsign)}</span>
              </div>
            `).join("")
          : `<div class="empty-state" style="padding:20px;">まだ参加者がいません。</div>`;

        body.innerHTML = `
          <span class="event-type-badge">${eventTypeLabel(ev.eventType)}</span>
          <h3 style="margin:10px 0 4px;">${escapeHtml(ev.title)}</h3>
          <div style="color:var(--text-dim); font-size:13px; margin-bottom:10px;">
            🕒 ${fmtEventDateTime(ev.startsAt)}${ev.endsAt ? ` 〜 ${fmtEventDateTime(ev.endsAt)}` : ""}<br />
            📍 ${escapeHtml(eventWhenWhereLine(ev))}<br />
            👥 ${eventCapacityLabel(ev)}
          </div>
          ${ev.description ? `<p style="white-space:pre-wrap; margin-bottom:14px;">${linkify(escapeHtml(ev.description))}</p>` : ""}
          <div style="display:flex; gap:8px; margin-bottom:14px;">
            <button type="button" class="btn ${ev.isJoined ? "btn-ghost" : "btn-primary"} btn-block" id="event-detail-join-btn">
              ${ev.isJoined ? "参加を取り消す" : "参加する"}
            </button>
            ${ev.isMine || state.isAdmin ? `<button type="button" class="btn btn-danger" id="event-detail-delete-btn">削除</button>` : ""}
          </div>
          <h4 style="margin:0 0 8px; font-size:13px; color:var(--text-dim);">参加者（${ev.participantCount}人）</h4>
          <div class="event-participant-list">${participantsHtml}</div>
        `;

        document.getElementById("event-detail-join-btn").addEventListener("click", async () => {
          try {
            await api(`/api/events/${eventId}/${ev.isJoined ? "leave" : "join"}`, { method: "POST" });
            await load();
            if (onChange) onChange();
          } catch (err) {
            toast(err.message);
          }
        });

        const deleteBtn = document.getElementById("event-detail-delete-btn");
        if (deleteBtn) {
          deleteBtn.addEventListener("click", async () => {
            if (!confirm("このイベントを削除しますか？")) return;
            try {
              await api(`/api/events/${eventId}`, { method: "DELETE" });
              toast("イベントを削除しました");
              popup.remove();
              if (onChange) onChange();
            } catch (err) {
              toast(err.message);
            }
          });
        }
      } catch (err) {
        body.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      }
    }

    load();
  }

  // ---------------------------------------------------------------- admin panel
  // Backed entirely by /api/admin/* (see routes/admin.js) — every request
  // below already requires requireAuth + requireAdmin server-side, so this
  // modal only needs to worry about UI state, not re-checking permissions.
  function openAdminPanelModal() {
    const adminState = {
      tab: "stats",
      stats: null,
      statsLoading: false,
      statsError: "",
      posts: [],
      postsLoading: false,
      postsError: "",
      postsSearch: "",
      postsType: "",
      postsAuthor: "",
      users: [],
      usersLoading: false,
      usersError: "",
      usersSearch: "",
      usersTotal: 0,
      adsLoaded: false,
      adsLoading: false,
      adsError: "",
      adsEnabled: false,
      adsCode: "",
      adsFrequency: 5,
      postsSeries: null,
      postsSeriesGranularity: "week",
      postsSeriesLoading: false,
      postsSeriesError: "",
      quakeTestHypocenter: "テスト震源",
      quakeTestScale: 55,
      quakeTestAreaCount: 3,
      warningTestAreaCode: "",
      warningTestHeadline: "（テスト）大雨警報が発表されました。土砂災害に警戒してください。",
      announcements: [],
      announcementsLoaded: false,
      announcementsLoading: false,
      announcementsError: "",
      announcementSending: false,
    };

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal admin-modal">
        <button class="modal-close" id="admin-close">✕</button>
        <h2>🛡️ 管理者パネル</h2>
        <div class="tabs">
          <button type="button" data-tab="stats" class="active">統計</button>
          <button type="button" data-tab="posts">投稿</button>
          <button type="button" data-tab="announcements">お知らせ</button>
          <button type="button" data-tab="ads">広告</button>
          <button type="button" data-tab="users">ユーザー</button>
          <button type="button" data-tab="quake">地震速報</button>
          <button type="button" data-tab="warning">気象警報</button>
        </div>
        <div id="admin-content"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("admin-close").addEventListener("click", () => overlay.remove());

    const contentEl = document.getElementById("admin-content");

    function setTab(tab) {
      adminState.tab = tab;
      overlay.querySelectorAll(".tabs button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
      });
      if (tab === "stats") { renderStatsTab(); if (!adminState.stats) loadStats(); if (!adminState.postsSeries) loadPostsSeries(); }
      else if (tab === "posts") { renderPostsTab(); if (!adminState.posts.length) loadPosts(); }
      else if (tab === "announcements") { renderAnnouncementsTab(); if (!adminState.announcementsLoaded) loadAnnouncements(); }
      else if (tab === "ads") { renderAdsTab(); if (!adminState.adsLoaded) loadAds(); }
      else if (tab === "quake") { renderQuakeTestTab(); }
      else if (tab === "warning") { renderWarningTestTab(); if (!state.warningAlert.areas) loadWarningAreas().then(renderWarningTestTab); }
      else { renderUsersTab(); if (!adminState.users.length) loadUsers(); }
    }

    overlay.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab));
    });

    // ---------------- stats tab ----------------
    async function loadStats() {
      adminState.statsLoading = true;
      adminState.statsError = "";
      renderStatsTab();
      try {
        adminState.stats = await api("/api/admin/stats");
      } catch (err) {
        adminState.statsError = err.message;
      } finally {
        adminState.statsLoading = false;
        renderStatsTab();
      }
    }

    async function loadPostsSeries() {
      adminState.postsSeriesLoading = true;
      adminState.postsSeriesError = "";
      renderStatsTab();
      try {
        // 日別は短い期間だと傾向が見えにくいので直近30日、週別/月別は12点。
        const periods = adminState.postsSeriesGranularity === "day" ? 30 : 12;
        adminState.postsSeries = await api(
          `/api/admin/stats/posts-timeseries?granularity=${adminState.postsSeriesGranularity}&periods=${periods}`
        );
      } catch (err) {
        adminState.postsSeriesError = err.message;
      } finally {
        adminState.postsSeriesLoading = false;
        renderStatsTab();
      }
    }

    function setPostsSeriesGranularity(granularity) {
      if (adminState.postsSeriesGranularity === granularity) return;
      adminState.postsSeriesGranularity = granularity;
      adminState.postsSeries = null; // force a refetch for the new bucketing
      loadPostsSeries();
    }

    // 依存ライブラリを増やしたくないので、SVGを直接組み立てるだけの
    // 軽量な折れ線グラフ。データ点は最大12個程度の想定で、ツールチップは
    // 各点に<title>を仕込むことでブラウザ標準のホバー表示に任せている。
    function renderPostsLineChart(payload, granularity) {
      const series = (payload && payload.series) || [];
      if (!series.length) return `<p class="admin-empty">データがありません</p>`;

      const width = 600;
      const height = 200;
      const padTop = 16;
      const padBottom = 28;
      const padX = 8;
      const maxCount = Math.max(1, ...series.map((p) => p.count));
      const plotHeight = height - padTop - padBottom;
      const stepX = series.length > 1 ? (width - padX * 2) / (series.length - 1) : 0;

      const xAt = (i) => padX + stepX * i;
      const yAt = (c) => padTop + plotHeight - (c / maxCount) * plotHeight;

      const points = series.map((p, i) => ({ ...p, x: xAt(i), y: yAt(p.count) }));
      const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(height - padBottom).toFixed(1)} `
        + `L${points[0].x.toFixed(1)},${(height - padBottom).toFixed(1)} Z`;

      // Grid lines + count labels at 0 / half / max.
      const gridLevels = [0, 0.5, 1];
      const gridLines = gridLevels.map((f) => {
        const y = padTop + plotHeight - f * plotHeight;
        return `
          <line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}" class="admin-linechart-grid" />
          <text x="0" y="${(y + 3).toFixed(1)}" class="admin-linechart-axis-label">${Math.round(f * maxCount)}</text>
        `;
      }).join("");

      // Avoid crowding the x-axis when there are many points — thin the
      // labels out but always keep the first and last.
      const labelEvery = series.length > 20 ? 5 : series.length > 8 ? 2 : 1;
      const formatLabel = (period) => {
        if (granularity === "month") {
          const [y, m] = period.split("-");
          return `${y.slice(2)}/${m}`;
        }
        const [, m, d] = period.split("-");
        return `${Number(m)}/${Number(d)}`;
      };
      const xLabels = points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return "";
        return `<text x="${p.x.toFixed(1)}" y="${height - 8}" class="admin-linechart-axis-label" text-anchor="middle">${escapeHtml(formatLabel(p.period))}</text>`;
      }).join("");

      const dots = points.map((p) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" class="admin-linechart-dot">
          <title>${escapeHtml(formatLabel(p.period))}: ${p.count}件</title>
        </circle>
      `).join("");

      return `
        <svg viewBox="0 0 ${width} ${height}" class="admin-linechart" preserveAspectRatio="none" role="img" aria-label="投稿数の推移">
          ${gridLines}
          <path d="${areaPath}" class="admin-linechart-area" />
          <path d="${linePath}" class="admin-linechart-line" />
          ${dots}
          ${xLabels}
        </svg>
      `;
    }

    function statCard(label, value) {
      return `<div class="admin-stat-card"><div class="admin-stat-value">${Number(value || 0).toLocaleString()}</div><div class="admin-stat-label">${escapeHtml(label)}</div></div>`;
    }

    function renderStatsTab() {
      if (adminState.tab !== "stats") return;
      if (adminState.statsLoading && !adminState.stats) {
        contentEl.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
        return;
      }
      if (adminState.statsError) {
        contentEl.innerHTML = `<div class="error-banner">${escapeHtml(adminState.statsError)}</div>`;
        return;
      }
      const s = adminState.stats;
      if (!s) { contentEl.innerHTML = ""; return; }
      const t = s.totals;
      const typeEntries = Object.entries(s.postsByType || {});
      const maxTypeCount = Math.max(1, ...typeEntries.map(([, c]) => c));
      const typeLabels = { text: "テキスト投稿", flight: "フライト投稿" };
      const typeRows = typeEntries.map(([type, count]) => {
        const pct = Math.round((count / maxTypeCount) * 100);
        return `
          <div class="admin-bar-row">
            <div class="admin-bar-label">${escapeHtml(typeLabels[type] || type)}</div>
            <div class="admin-bar-track"><div class="admin-bar-fill" style="width:${pct}%"></div></div>
            <div class="admin-bar-value">${Number(count).toLocaleString()}</div>
          </div>`;
      }).join("");

      const g = adminState.postsSeriesGranularity;
      const seriesBody = adminState.postsSeriesError
        ? `<div class="error-banner">${escapeHtml(adminState.postsSeriesError)}</div>`
        : adminState.postsSeriesLoading && !adminState.postsSeries
          ? `<div class="spinner-row">読み込み中...</div>`
          : renderPostsLineChart(adminState.postsSeries, g);

      contentEl.innerHTML = `
        <div class="admin-stat-grid">
          ${statCard("ユーザー", t.users)}
          ${statCard("投稿", t.posts)}
          ${statCard("コメント", t.comments)}
          ${statCard("いいね", t.likes)}
          ${statCard("フォロー", t.follows)}
          ${statCard("プッシュ購読", t.pushSubscriptions)}
          ${statCard("BAN済み", t.bannedUsers)}
          ${statCard("管理者", t.adminUsers)}
        </div>
        <h3 class="admin-section-title">直近7日間</h3>
        <div class="admin-stat-grid admin-stat-grid-2">
          ${statCard("新規ユーザー", s.last7Days.newUsers)}
          ${statCard("新規投稿", s.last7Days.newPosts)}
        </div>
        <div class="admin-section-title-row">
          <h3 class="admin-section-title" style="margin:0;">投稿数の推移</h3>
          <div class="admin-toggle-group" id="admin-posts-series-toggle">
            <button type="button" data-granularity="day" class="${g === "day" ? "active" : ""}">日別</button>
            <button type="button" data-granularity="week" class="${g === "week" ? "active" : ""}">週別</button>
            <button type="button" data-granularity="month" class="${g === "month" ? "active" : ""}">月別</button>
          </div>
        </div>
        <div class="admin-linechart-wrap">${seriesBody}</div>
        <h3 class="admin-section-title">投稿タイプ別</h3>
        <div class="admin-bar-chart">${typeRows || `<p class="admin-empty">データがありません</p>`}</div>
      `;

      const toggle = contentEl.querySelector("#admin-posts-series-toggle");
      if (toggle) {
        toggle.querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", () => setPostsSeriesGranularity(btn.dataset.granularity));
        });
      }
    }

    // ---------------- posts tab ----------------
    let postsSearchTimer = null;

    async function loadPosts() {
      adminState.postsLoading = true;
      adminState.postsError = "";
      renderPostsTab();
      try {
        const params = new URLSearchParams();
        if (adminState.postsSearch) params.set("search", adminState.postsSearch);
        if (adminState.postsType) params.set("type", adminState.postsType);
        if (adminState.postsAuthor) params.set("author", adminState.postsAuthor);
        params.set("limit", "50");
        const { posts } = await api(`/api/admin/posts?${params.toString()}`);
        adminState.posts = posts;
      } catch (err) {
        adminState.postsError = err.message;
      } finally {
        adminState.postsLoading = false;
        renderPostsTab();
      }
    }

    async function deleteAdminPost(id) {
      if (!confirm("この投稿を削除しますか？ この操作は取り消せません。")) return;
      try {
        await api(`/api/admin/posts/${id}`, { method: "DELETE" });
        adminState.posts = adminState.posts.filter((p) => p.id !== id);
        renderPostsTab();
        toast("投稿を削除しました");
      } catch (err) {
        toast(err.message);
      }
    }

    function renderPostsTab() {
      if (adminState.tab !== "posts") return;
      const rows = adminState.posts.map((p) => `
        <div class="admin-list-row">
          <div class="admin-list-main">
            <div class="admin-list-title">
              <strong>${escapeHtml(p.authorCallsign)}</strong>
              <span class="admin-badge">${p.type === "flight" ? "フライト" : "テキスト"}</span>
            </div>
            <div class="admin-list-sub">${p.text ? escapeHtml(p.text.slice(0, 80)) : "<em>(本文なし)</em>"}</div>
            <div class="admin-list-meta">❤️ ${p.likeCount} ・ 💬 ${p.commentCount} ・ ${fmtTime(p.createdAt)}</div>
          </div>
          <button type="button" class="btn btn-danger admin-delete-post-btn" data-id="${p.id}" style="padding:6px 12px; font-size:12px;">削除</button>
        </div>
      `).join("");

      contentEl.innerHTML = `
        <div class="admin-filter-row">
          <input type="text" id="admin-posts-search" placeholder="本文を検索..." value="${escapeHtml(adminState.postsSearch)}" />
          <select id="admin-posts-type">
            <option value="" ${adminState.postsType === "" ? "selected" : ""}>すべて</option>
            <option value="text" ${adminState.postsType === "text" ? "selected" : ""}>テキスト</option>
            <option value="flight" ${adminState.postsType === "flight" ? "selected" : ""}>フライト</option>
          </select>
          <input type="text" id="admin-posts-author" placeholder="コールサイン" value="${escapeHtml(adminState.postsAuthor)}" style="max-width:130px;" />
        </div>
        <div class="admin-list">
          ${adminState.postsLoading ? `<div class="spinner-row">読み込み中...</div>` : ""}
          ${adminState.postsError ? `<div class="error-banner">${escapeHtml(adminState.postsError)}</div>` : ""}
          ${!adminState.postsLoading && !adminState.postsError && !rows ? `<p class="admin-empty">投稿が見つかりません</p>` : rows}
        </div>
      `;

      document.getElementById("admin-posts-search").addEventListener("input", (e) => {
        clearTimeout(postsSearchTimer);
        const value = e.target.value;
        postsSearchTimer = setTimeout(() => { adminState.postsSearch = value; loadPosts(); }, 350);
      });
      document.getElementById("admin-posts-type").addEventListener("change", (e) => {
        adminState.postsType = e.target.value;
        loadPosts();
      });
      document.getElementById("admin-posts-author").addEventListener("change", (e) => {
        adminState.postsAuthor = e.target.value.trim();
        loadPosts();
      });
      contentEl.querySelectorAll(".admin-delete-post-btn").forEach((btn) => {
        btn.addEventListener("click", () => deleteAdminPost(btn.dataset.id));
      });
    }

    // ---------------- announcements tab (運営からのメッセージ) ----------------
    async function loadAnnouncements() {
      adminState.announcementsLoading = true;
      adminState.announcementsError = "";
      renderAnnouncementsTab();
      try {
        const { announcements } = await api("/api/admin/announcements");
        adminState.announcements = announcements;
        adminState.announcementsLoaded = true;
      } catch (err) {
        adminState.announcementsError = err.message;
      } finally {
        adminState.announcementsLoading = false;
        renderAnnouncementsTab();
      }
    }

    async function deleteAdminAnnouncement(id) {
      if (!confirm("このお知らせを削除しますか？(すでに届いた通知/バナー自体は取り消せません)")) return;
      try {
        await api(`/api/admin/announcements/${id}`, { method: "DELETE" });
        adminState.announcements = adminState.announcements.filter((a) => a.id !== id);
        renderAnnouncementsTab();
      } catch (err) {
        toast(err.message);
      }
    }

    const ANNOUNCEMENT_MESSAGE_MAX_LEN = 500;

    function renderAnnouncementsTab() {
      if (adminState.tab !== "announcements") return;
      const rows = adminState.announcements.map((a) => `
        <div class="admin-list-row">
          <div class="admin-list-main">
            <div class="admin-list-sub">${escapeHtml(a.message)}</div>
            <div class="admin-list-meta">${escapeHtml(a.authorCallsign)} ・ ${fmtTime(a.createdAt)}</div>
          </div>
          <button type="button" class="btn btn-danger admin-delete-announcement-btn" data-id="${a.id}" style="padding:6px 12px; font-size:12px;">削除</button>
        </div>
      `).join("");

      contentEl.innerHTML = `
        <p class="admin-ads-hint">ここで送信すると、今開いている全ユーザーの画面に即座にバナーで表示され、タブを閉じているユーザーにもプッシュ通知が届きます(通知設定に関わらず全員へ送信されます)。</p>
        ${adminState.announcementsError ? `<div class="error-banner">${escapeHtml(adminState.announcementsError)}</div>` : ""}
        <form id="admin-announcement-form">
          <div class="field">
            <label>メッセージ</label>
            <textarea id="admin-announcement-message" rows="4" maxlength="${ANNOUNCEMENT_MESSAGE_MAX_LEN}" placeholder="例: 本日23時よりメンテナンスのため一時的にご利用いただけません。"></textarea>
          </div>
          <button type="submit" class="btn btn-primary" id="admin-announcement-send" ${adminState.announcementSending ? "disabled" : ""}>
            ${adminState.announcementSending ? "送信中..." : "全員に送信"}
          </button>
        </form>
        <h4 style="margin:22px 0 10px; font-size:14px;">送信履歴</h4>
        <div class="admin-list">
          ${adminState.announcementsLoading ? `<div class="spinner-row">読み込み中...</div>` : ""}
          ${!adminState.announcementsLoading && !rows ? `<p class="admin-empty">まだお知らせを送信していません</p>` : rows}
        </div>
      `;

      document.getElementById("admin-announcement-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const textarea = document.getElementById("admin-announcement-message");
        const message = textarea.value.trim();
        if (!message) return;
        adminState.announcementSending = true;
        renderAnnouncementsTab();
        try {
          const { announcement } = await api("/api/admin/announcements", {
            method: "POST",
            body: JSON.stringify({ message }),
          });
          adminState.announcements.unshift(announcement);
          toast("お知らせを送信しました");
        } catch (err) {
          toast(err.message);
        } finally {
          adminState.announcementSending = false;
          renderAnnouncementsTab();
        }
      });
      contentEl.querySelectorAll(".admin-delete-announcement-btn").forEach((btn) => {
        btn.addEventListener("click", () => deleteAdminAnnouncement(btn.dataset.id));
      });
    }

    // ---------------- ads tab ----------------
    async function loadAds() {
      adminState.adsLoading = true;
      adminState.adsError = "";
      renderAdsTab();
      try {
        const ads = await api("/api/admin/ads");
        adminState.adsEnabled = ads.enabled;
        adminState.adsCode = ads.code;
        adminState.adsFrequency = ads.frequency;
        adminState.adsLoaded = true;
      } catch (err) {
        adminState.adsError = err.message;
      } finally {
        adminState.adsLoading = false;
        renderAdsTab();
      }
    }

    function renderAdsTab() {
      if (adminState.tab !== "ads") return;
      if (adminState.adsLoading && !adminState.adsLoaded) {
        contentEl.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
        return;
      }

      contentEl.innerHTML = `
        <p class="admin-ads-hint">Google AdSenseや忍者AdMaxなど、広告ネットワークが発行する貼り付け用コード（&lt;script&gt;タグを含むもの）をそのまま貼り付けてください。フィードの投稿の間に、下で指定した投稿数ごとに挿入されます。</p>
        ${adminState.adsError ? `<div class="error-banner">${escapeHtml(adminState.adsError)}</div>` : ""}
        <form id="admin-ads-form">
          <div class="field">
            <label style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" id="admin-ads-enabled" ${adminState.adsEnabled ? "checked" : ""} style="width:auto;" />
              フィードに広告を表示する
            </label>
          </div>
          <div class="field">
            <label>広告コード</label>
            <textarea id="admin-ads-code" rows="10" placeholder="<script>...</script> など、広告ネットワークの貼り付けコードをそのまま貼り付け" style="font-family: monospace; font-size: 12px;">${escapeHtml(adminState.adsCode)}</textarea>
          </div>
          <div class="field">
            <label>広告の挿入間隔（投稿何件ごとに1つ表示するか）</label>
            <input type="number" id="admin-ads-frequency" min="1" max="50" value="${adminState.adsFrequency}" style="max-width:120px;" />
          </div>
          <button type="submit" class="btn btn-primary" id="admin-ads-save">保存</button>
        </form>
      `;

      document.getElementById("admin-ads-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById("admin-ads-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中...";
        try {
          const enabled = document.getElementById("admin-ads-enabled").checked;
          const code = document.getElementById("admin-ads-code").value;
          const frequency = Math.max(1, Number(document.getElementById("admin-ads-frequency").value) || 5);
          const saved = await api("/api/admin/ads", {
            method: "PUT",
            body: JSON.stringify({ enabled, code, frequency }),
          });
          adminState.adsEnabled = saved.enabled;
          adminState.adsCode = saved.code;
          adminState.adsFrequency = saved.frequency;
          state.adConfig = saved;
          renderFeedList();
          toast("広告設定を保存しました");
        } catch (err) {
          toast(err.message);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "保存";
        }
      });
    }

    // ---------------- quake (EEW popup test) tab ----------------
    // Purely client-side — unlike the other tabs, there's no server round
    // trip here. It reuses the exact same showEewPopup() the real
    // wss://api.p2pquake.net feed calls (see handleQuakeMessage), so
    // whatever's picked here previews precisely what a real code-556
    // message would trigger, without needing the p2pquake sandbox feed
    // (connectQuakeSandboxWS/QUAKE_SANDBOX_WS_URL, used by the quake
    // panel's own separate "テスト表示" button) to actually broadcast one.
    function renderQuakeTestTab() {
      if (adminState.tab !== "quake") return;

      const scaleOptions = Object.entries(SCALE_LABELS)
        .filter(([code]) => code !== "-1")
        .map(([code, label]) => `<option value="${code}" ${Number(code) === adminState.quakeTestScale ? "selected" : ""}>震度${label}</option>`)
        .join("");

      contentEl.innerHTML = `
        <p class="admin-ads-hint">緊急地震速報（EEW）の上部スライドインポップアップを、実際の受信を待たずにこの画面から試せます。表示されるのはテスト表示バッジ付きのポップアップのみで、地震情報パネルの状態には反映されません。</p>
        <form id="admin-quake-test-form">
          <div class="field">
            <label>震源名</label>
            <input type="text" id="admin-quake-test-hypocenter" value="${escapeHtml(adminState.quakeTestHypocenter)}" maxlength="40" />
          </div>
          <div class="field">
            <label>予想最大震度</label>
            <select id="admin-quake-test-scale">${scaleOptions}</select>
          </div>
          <div class="field">
            <label>対象地域数</label>
            <input type="number" id="admin-quake-test-areas" min="0" max="999" value="${adminState.quakeTestAreaCount}" style="max-width:120px;" />
          </div>
          <button type="submit" class="btn btn-primary">ポップアップを表示（予報）</button>
        </form>
        <div class="field" style="margin-top:14px; display:flex; gap:8px;">
          <button type="button" class="btn btn-ghost" id="admin-quake-test-detection" style="flex:1;">検知のみを表示</button>
          <button type="button" class="btn btn-ghost" id="admin-quake-test-cancelled" style="flex:1;">取り消しを表示</button>
        </div>
      `;

      document.getElementById("admin-quake-test-form").addEventListener("submit", (e) => {
        e.preventDefault();
        adminState.quakeTestHypocenter = document.getElementById("admin-quake-test-hypocenter").value.trim() || "テスト震源";
        adminState.quakeTestScale = Number(document.getElementById("admin-quake-test-scale").value);
        adminState.quakeTestAreaCount = Math.max(0, Number(document.getElementById("admin-quake-test-areas").value) || 0);
        showEewPopup({
          isTest: true,
          hypocenterName: adminState.quakeTestHypocenter,
          maxScale: adminState.quakeTestScale,
          areaCount: adminState.quakeTestAreaCount,
        });
      });
      document.getElementById("admin-quake-test-detection").addEventListener("click", () => {
        showEewPopup({ isTest: true, detectionOnly: true });
      });
      document.getElementById("admin-quake-test-cancelled").addEventListener("click", () => {
        showEewPopup({ isTest: true, cancelled: true });
      });
    }

    // ---------------- weather warning test tab ----------------
    // 地震速報のテストタブと同じ方針: サーバーには一切ラウンドトリップ
    // せず、このブラウザでshowWarningBar()を直接呼んで見た目だけ試す。
    // 実際のユーザーへ本物のpush通知は一切送らない。
    function renderWarningTestTab() {
      if (adminState.tab !== "warning") return;

      const areas = state.warningAlert.areas || [];
      const options = areas
        .map((a) => `<option value="${a.code}" ${a.code === adminState.warningTestAreaCode ? "selected" : ""}>${escapeHtml(a.name)}</option>`)
        .join("");

      contentEl.innerHTML = `
        <p class="admin-ads-hint">気象警報・注意報の上部スライドインバナーを、実際の配信を待たずにこの画面から試せます。表示されるのはテスト配信バッジ付きのバナーのみで、実際のユーザーには一切通知が送られません。</p>
        <form id="admin-warning-test-form">
          <div class="field">
            <label>地域</label>
            <select id="admin-warning-test-area">
              <option value="">選択...</option>
              ${options}
            </select>
          </div>
          <div class="field">
            <label>見出し文</label>
            <textarea id="admin-warning-test-headline" rows="3" maxlength="200">${escapeHtml(adminState.warningTestHeadline)}</textarea>
          </div>
          <button type="submit" class="btn btn-primary">バナーを表示</button>
        </form>
      `;

      document.getElementById("admin-warning-test-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const areaCode = document.getElementById("admin-warning-test-area").value;
        adminState.warningTestAreaCode = areaCode;
        adminState.warningTestHeadline = document.getElementById("admin-warning-test-headline").value.trim()
          || "（テスト）大雨警報が発表されました。土砂災害に警戒してください。";
        const area = areas.find((a) => a.code === areaCode);
        showWarningBar({
          isTest: true,
          areaName: area ? area.name : "テスト地域",
          headline: adminState.warningTestHeadline,
        });
      });
    }

    // ---------------- users tab ----------------
    let usersSearchTimer = null;

    async function loadUsers() {
      adminState.usersLoading = true;
      adminState.usersError = "";
      renderUsersTab();
      try {
        const params = new URLSearchParams();
        if (adminState.usersSearch) params.set("search", adminState.usersSearch);
        params.set("limit", "50");
        const { users, total } = await api(`/api/admin/users?${params.toString()}`);
        adminState.users = users;
        adminState.usersTotal = total;
      } catch (err) {
        adminState.usersError = err.message;
      } finally {
        adminState.usersLoading = false;
        renderUsersTab();
      }
    }

    async function patchAdminUser(id, patch) {
      try {
        const { user } = await api(`/api/admin/users/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        adminState.users = adminState.users.map((u) => (u.id === id ? user : u));
        renderUsersTab();
      } catch (err) {
        toast(err.message);
      }
    }

    async function deleteAdminUser(id, callsign) {
      if (!confirm(`${callsign} を完全に削除しますか？ 投稿・コメント等もすべて削除され、取り消せません。`)) return;
      try {
        await api(`/api/admin/users/${id}`, { method: "DELETE" });
        adminState.users = adminState.users.filter((u) => u.id !== id);
        adminState.usersTotal = Math.max(0, adminState.usersTotal - 1);
        renderUsersTab();
        toast(`${callsign} を削除しました`);
      } catch (err) {
        toast(err.message);
      }
    }

    function renderUsersTab() {
      if (adminState.tab !== "users") return;
      const rows = adminState.users.map((u) => {
        const isSelf = !!(state.user && u.id === state.user.id);
        const adminBtnDisabled = isSelf && u.isAdmin;
        return `
        <div class="admin-list-row">
          <div class="admin-list-main">
            <div class="admin-list-title">
              <strong>${escapeHtml(u.callsign)}</strong>
              <span class="admin-list-name">${escapeHtml(u.name)}</span>
              ${u.isAdmin ? `<span class="admin-badge admin-badge-admin">管理者</span>` : ""}
              ${u.isBanned ? `<span class="admin-badge admin-badge-banned">BAN中</span>` : ""}
            </div>
            <div class="admin-list-meta">投稿 ${u.postCount} ・ フォロワー ${u.followerCount} ・ ${fmtTime(u.joined)}</div>
          </div>
          <div class="admin-list-actions">
            <button type="button" class="btn btn-ghost admin-toggle-admin-btn" data-id="${u.id}" data-value="${u.isAdmin ? "0" : "1"}" style="padding:6px 10px; font-size:12px;" ${adminBtnDisabled ? "disabled title='自分自身の管理者権限は解除できません'" : ""}>
              ${u.isAdmin ? "管理者解除" : "管理者にする"}
            </button>
            <button type="button" class="btn ${u.isBanned ? "btn-ghost" : "btn-danger"} admin-toggle-ban-btn" data-id="${u.id}" data-value="${u.isBanned ? "0" : "1"}" style="padding:6px 10px; font-size:12px;" ${isSelf ? "disabled title='自分自身はBANできません'" : ""}>
              ${u.isBanned ? "BAN解除" : "BAN"}
            </button>
            <button type="button" class="btn btn-danger admin-delete-user-btn" data-id="${u.id}" data-callsign="${escapeHtml(u.callsign)}" style="padding:6px 10px; font-size:12px;" ${isSelf ? "disabled title='自分自身は削除できません'" : ""}>削除</button>
          </div>
        </div>
      `;
      }).join("");

      contentEl.innerHTML = `
        <div class="admin-filter-row">
          <input type="text" id="admin-users-search" placeholder="コールサイン・名前で検索..." value="${escapeHtml(adminState.usersSearch)}" />
          <span class="admin-filter-total">${adminState.usersTotal ? `${adminState.usersTotal.toLocaleString()}件` : ""}</span>
        </div>
        <div class="admin-list">
          ${adminState.usersLoading ? `<div class="spinner-row">読み込み中...</div>` : ""}
          ${adminState.usersError ? `<div class="error-banner">${escapeHtml(adminState.usersError)}</div>` : ""}
          ${!adminState.usersLoading && !adminState.usersError && !rows ? `<p class="admin-empty">ユーザーが見つかりません</p>` : rows}
        </div>
      `;

      document.getElementById("admin-users-search").addEventListener("input", (e) => {
        clearTimeout(usersSearchTimer);
        const value = e.target.value;
        usersSearchTimer = setTimeout(() => { adminState.usersSearch = value; loadUsers(); }, 350);
      });
      contentEl.querySelectorAll(".admin-toggle-admin-btn").forEach((btn) => {
        if (btn.disabled) return;
        btn.addEventListener("click", () => patchAdminUser(btn.dataset.id, { isAdmin: btn.dataset.value === "1" }));
      });
      contentEl.querySelectorAll(".admin-toggle-ban-btn").forEach((btn) => {
        if (btn.disabled) return;
        btn.addEventListener("click", () => patchAdminUser(btn.dataset.id, { isBanned: btn.dataset.value === "1" }));
      });
      contentEl.querySelectorAll(".admin-delete-user-btn").forEach((btn) => {
        if (btn.disabled) return;
        btn.addEventListener("click", () => deleteAdminUser(btn.dataset.id, btn.dataset.callsign));
      });
    }

    renderStatsTab();
    loadStats();
  }


  function openProfileModal() {
    let pendingAvatarFile = null;
    let pendingAvatarPreview = null;

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-close" id="profile-close">✕</button>
        <h2>プロフィール編集</h2>
        <div class="avatar-picker">
          <div id="profile-avatar-preview">${avatarHtml(state.user, 72)}</div>
          <div>
            <button type="button" class="btn btn-ghost" id="profile-pick-avatar">写真を変更</button>
            <input type="file" id="profile-avatar-input" accept="image/*" class="hidden-file-input" />
          </div>
        </div>
        <form id="profile-form">
          <div class="field">
            <label>表示名</label>
            <input name="name" value="${escapeHtml(state.user.name || "")}" required />
          </div>
          <div class="field">
            <label>拠点空港コード</label>
            <input name="homeBase" value="${escapeHtml(state.user.homeBase || "")}" maxlength="4" />
          </div>
          <div class="field">
            <label>自己紹介</label>
            <textarea name="bio" maxlength="280">${escapeHtml(state.user.bio || "")}</textarea>
          </div>
          <div class="field">
            <label>好きなアニメ</label>
            <div id="favorite-anime-editor" class="anime-editor">
              ${(state.user.favoriteAnimeList && state.user.favoriteAnimeList.length ? state.user.favoriteAnimeList : [""]).map((title) => `
                <div class="anime-editor-row">
                  <input type="text" class="anime-editor-input" value="${escapeHtml(title)}" maxlength="100" placeholder="例: 機動戦士ガンダム" />
                  <button type="button" class="anime-editor-remove" aria-label="削除">✕</button>
                </div>
              `).join("")}
            </div>
            <button type="button" class="btn btn-ghost btn-block" id="anime-editor-add">+ アニメを追加</button>
          </div>
          ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
          <div style="display:flex; gap:10px; margin-top: 6px;">
            <button type="submit" class="btn btn-primary" id="profile-save" style="flex:1">保存</button>
            <button type="button" class="btn btn-ghost" id="profile-logout">ログアウト</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("profile-close").addEventListener("click", () => overlay.remove());
    document.getElementById("profile-logout").addEventListener("click", () => { overlay.remove(); logout(); });

    document.getElementById("profile-pick-avatar").addEventListener("click", () => {
      document.getElementById("profile-avatar-input").click();
    });

    document.getElementById("profile-avatar-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      pendingAvatarFile = file;
      pendingAvatarPreview = URL.createObjectURL(file);
      document.getElementById("profile-avatar-preview").innerHTML =
        `<img class="avatar" style="width:72px;height:72px" src="${pendingAvatarPreview}" alt="preview" />`;
    });

    // 好きなアニメの行を増減する。最大10件(サーバー側の上限と合わせる)。
    const ANIME_MAX = 10;
    const animeEditor = document.getElementById("favorite-anime-editor");
    function addAnimeRow(focus) {
      if (animeEditor.querySelectorAll(".anime-editor-row").length >= ANIME_MAX) return;
      const row = document.createElement("div");
      row.className = "anime-editor-row";
      row.innerHTML = `
        <input type="text" class="anime-editor-input" maxlength="100" placeholder="例: 機動戦士ガンダム" />
        <button type="button" class="anime-editor-remove" aria-label="削除">✕</button>
      `;
      animeEditor.appendChild(row);
      if (focus) row.querySelector("input").focus();
    }
    animeEditor.addEventListener("click", (e) => {
      const btn = e.target.closest(".anime-editor-remove");
      if (!btn) return;
      const rows = animeEditor.querySelectorAll(".anime-editor-row");
      if (rows.length <= 1) {
        btn.closest(".anime-editor-row").querySelector("input").value = "";
      } else {
        btn.closest(".anime-editor-row").remove();
      }
    });
    document.getElementById("anime-editor-add").addEventListener("click", () => addAnimeRow(true));

    document.getElementById("profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const favoriteAnimeList = Array.from(animeEditor.querySelectorAll(".anime-editor-input"))
        .map((input) => input.value.trim())
        .filter(Boolean);
      const saveBtn = document.getElementById("profile-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中...";
      try {
        await updateProfile({
          name: fd.get("name"),
          homeBase: fd.get("homeBase"),
          bio: fd.get("bio"),
          favoriteAnimeList,
          avatarFile: pendingAvatarFile,
        });
        overlay.remove();
        renderMainScreen();
        toast("プロフィールを更新しました");
      } catch (err) {
        state.error = err.message;
        overlay.remove();
        openProfileModal();
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存";
      }
    });
  }

  // ---------------------------------------------------------------- top-level render
  function render() {
    if (!state.booted) {
      root.innerHTML = `<div class="spinner-row">読み込み中...</div>`;
      return;
    }
    if (!state.user) {
      renderAuthScreen();
    } else {
      renderMainScreen();
    }
  }

  // ---------------------------------------------------------------- overlay scroll lock
  // Every popup (post detail, profile, SimBrief import, flight detail,
  // image lightbox, ...) is appended directly to <body> as a .modal-backdrop
  // or .lightbox element and later removed by its own close handler. Rather
  // than threading a lock/unlock call through every one of those call
  // sites, a single observer watches <body> and toggles scrolling based on
  // whether any overlay is currently present.
  new MutationObserver(() => {
    const hasOverlay = !!document.body.querySelector(".modal-backdrop, .lightbox");
    document.body.style.overflow = hasOverlay ? "hidden" : "";
  }).observe(document.body, { childList: true });

  boot();
})();
