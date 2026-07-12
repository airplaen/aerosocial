(() => {
  "use strict";

  const root = document.getElementById("root");
  const TOKEN_KEY = "aerosocial_token";
  const SIMBRIEF_USERNAME_KEY = "aerosocial_simbrief_username";

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: null,
    posts: [],
    commentsByPost: {},
    openComments: new Set(),
    wsConnected: false,
    lightboxUrl: null,
    profileModalOpen: false,
    authMode: "login",
    booted: false,
    error: "",
    composerFile: null,
    composerPreviewUrl: null,
    submitting: false,
    // A flight card fetched from SimBrief, waiting to be attached to the
    // next post the user submits from the composer.
    pendingFlight: null,
    // Top liked flight-type posts, shown in the "人気のフライト" panel.
    popularFlights: [],
  };

  let ws = null;
  let wsRetryTimer = null;

  // ---------------------------------------------------------------- utils
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
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
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${core}</a>${rest}`;
    });
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
    if (f.route) badges.push(`<span class="flight-badge" title="${escapeHtml(f.route)}">🗺️ ${escapeHtml(f.route)}</span>`);

    const stats = [];
    if (f.durMin != null) stats.push(`<div class="stat"><b>${Math.round(f.durMin)}分</b>飛行時間</div>`);
    if (f.distance != null) stats.push(`<div class="stat"><b>${f.distance}nm</b>距離</div>`);
    if (f.cruiseAlt != null) stats.push(`<div class="stat"><b>FL${Math.round(f.cruiseAlt / 100)}</b>巡航高度</div>`);
    if (f.eta) {
      const etaStr = new Date(f.eta).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      stats.push(`<div class="stat"><b>${etaStr}</b>到着予定</div>`);
    }

    return `
      ${hasRoute ? `<div class="flight-route-row"><b>${escapeHtml(f.originIcao || "?")}</b><span class="flight-arrow">→</span><b>${escapeHtml(f.destIcao || "?")}</b></div>` : ""}
      ${subtitle ? `<div class="flight-subtitle">${subtitle}</div>` : ""}
      ${badges.length ? `<div class="flight-badges">${badges.join("")}</div>` : ""}
      ${stats.length ? `<div class="flight-stats">${stats.join("")}</div>` : ""}
    `;
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

  // ---------------------------------------------------------------- data actions
  async function boot() {
    if (state.token) {
      try {
        const { user } = await api("/api/users/me");
        state.user = user;
      } catch {
        setToken(null);
        state.user = null;
      }
    }
    state.booted = true;
    render();
    if (state.user) {
      await loadFeed();
      loadPopularFlights();
    }
    connectWS();
  }

  async function loadFeed() {
    try {
      const { posts } = await api("/api/posts?limit=30");
      state.posts = posts;
      renderFeedList();
    } catch (err) {
      toast(err.message);
    }
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

  async function login(callsign, password) {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ callsign, password }) });
    setToken(data.token);
    state.user = data.user;
  }

  async function register(fields) {
    const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify(fields) });
    setToken(data.token);
    state.user = data.user;
  }

  function logout() {
    setToken(null);
    state.user = null;
    state.posts = [];
    if (ws) ws.close();
    render();
  }

  async function createPost(text, file, flight) {
    const form = new FormData();
    if (text) form.append("text", text);
    if (file) form.append("image", file);
    if (flight) form.append("flight", JSON.stringify(flight));
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
    const list = state.commentsByPost[postId] || [];
    state.commentsByPost[postId] = [...list, comment];
    const post = state.posts.find((p) => p.id === postId);
    if (post) post.commentCount += 1;
    renderFeedList();
  }

  async function updateProfile({ name, bio, homeBase, avatarFile }) {
    const form = new FormData();
    if (name !== undefined) form.append("name", name);
    if (bio !== undefined) form.append("bio", bio);
    if (homeBase !== undefined) form.append("homeBase", homeBase);
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
    if (!state.user) return;
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
      if (state.user) wsRetryTimer = setTimeout(connectWS, 3000);
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
      case "comment:new": {
        const post = state.posts.find((p) => p.id === msg.payload.postId);
        if (post) {
          post.commentCount += 1;
          if (state.openComments.has(post.id)) {
            const list = state.commentsByPost[post.id] || [];
            if (!list.some((c) => c.id === msg.payload.comment.id)) {
              state.commentsByPost[post.id] = [...list, msg.payload.comment];
            }
          }
          renderFeedList();
        }
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- render: auth
  function renderAuthScreen() {
    const isLogin = state.authMode === "login";
    root.innerHTML = `
      <div class="auth-wrap">
        <h1>✈️ AeroSocial</h1>
        <p class="sub">パイロットのためのソーシャルフィード</p>
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
        <div class="tabs">
          <button data-mode="login" class="${isLogin ? "active" : ""}">ログイン</button>
          <button data-mode="register" class="${!isLogin ? "active" : ""}">新規登録</button>
        </div>
        <form id="auth-form">
          <div class="field">
            <label>コールサイン</label>
            <input name="callsign" placeholder="例: SKYHAWK1" autocomplete="username" required />
          </div>
          ${!isLogin ? `
          <div class="field">
            <label>表示名</label>
            <input name="name" placeholder="表示名" />
          </div>
          <div class="field">
            <label>拠点空港コード (任意)</label>
            <input name="homeBase" placeholder="例: RJTT" maxlength="4" />
          </div>
          ` : ""}
          <div class="field">
            <label>パスワード</label>
            <input name="password" type="password" placeholder="8文字以上" autocomplete="${isLogin ? "current-password" : "new-password"}" required />
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">${isLogin ? "ログイン" : "アカウント作成"}</button>
        </form>
      </div>
    `;

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.authMode = btn.dataset.mode;
        state.error = "";
        renderAuthScreen();
      });
    });

    document.getElementById("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = document.getElementById("auth-submit");
      submitBtn.disabled = true;
      state.error = "";
      try {
        if (isLogin) {
          await login(fd.get("callsign"), fd.get("password"));
        } else {
          await register({
            callsign: fd.get("callsign"),
            name: fd.get("name"),
            homeBase: fd.get("homeBase"),
            password: fd.get("password"),
          });
        }
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
        <div class="topbar">
          <div class="brand"><span class="dot"></span>AeroSocial</div>
          <div class="topbar-actions">
            <div class="ws-indicator"><span class="ws-dot" id="ws-dot"></span></div>
            <button type="button" class="btn btn-ghost" id="my-posts-btn" style="padding:6px 12px; font-size:13px;">マイ投稿</button>
            <div id="avatar-slot"></div>
          </div>
        </div>

        <div class="composer">
          <div class="composer-top">
            ${avatarHtml(state.user, 40)}
            <textarea id="composer-text" placeholder="フライトの様子をシェアしよう..." rows="2"></textarea>
          </div>
          <div id="composer-preview-slot"></div>
          <div id="composer-flight-slot"></div>
          <div class="composer-actions">
            <div>
              <button class="icon-btn" id="pick-image-btn" title="画像を追加">🖼️</button>
              <input type="file" id="composer-file-input" accept="image/*" class="hidden-file-input" />
            </div>
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-ghost" id="simbrief-import-btn">📋 SimBrief</button>
              <button class="btn btn-primary" id="composer-submit">投稿</button>
            </div>
          </div>
        </div>

        <div id="popular-flights-slot"></div>
        <div id="feed-stats-slot"></div>
        <div id="feed-list"></div>
      </div>
    `;

    document.getElementById("avatar-slot").innerHTML = avatarHtml(state.user, 34);
    document.getElementById("avatar-slot").addEventListener("click", openProfileModal);
    document.getElementById("my-posts-btn").addEventListener("click", () => openUserProfile(state.user.callsign));

    document.getElementById("pick-image-btn").addEventListener("click", () => {
      document.getElementById("composer-file-input").click();
    });

    document.getElementById("composer-file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      state.composerFile = file;
      state.composerPreviewUrl = URL.createObjectURL(file);
      renderComposerPreview();
    });

    document.getElementById("composer-submit").addEventListener("click", onSubmitPost);
    document.getElementById("simbrief-import-btn").addEventListener("click", openSimbriefModal);

    renderComposerPreview();
    renderComposerFlightPreview();
    updateWsIndicator();
    renderFeedList();
    renderPopularFlights();
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
    document.getElementById("remove-flight-btn").addEventListener("click", () => {
      state.pendingFlight = null;
      renderComposerFlightPreview();
    });
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

  function renderComposerPreview() {
    const slot = document.getElementById("composer-preview-slot");
    if (!slot) return;
    if (!state.composerPreviewUrl) { slot.innerHTML = ""; return; }
    slot.innerHTML = `
      <div class="composer-preview">
        <img src="${state.composerPreviewUrl}" alt="preview" />
        <button class="remove-preview" id="remove-preview-btn">✕</button>
      </div>
    `;
    document.getElementById("remove-preview-btn").addEventListener("click", () => {
      state.composerFile = null;
      URL.revokeObjectURL(state.composerPreviewUrl);
      state.composerPreviewUrl = null;
      document.getElementById("composer-file-input").value = "";
      renderComposerPreview();
    });
  }

  async function onSubmitPost() {
    const textEl = document.getElementById("composer-text");
    const text = textEl.value.trim();
    if (!text && !state.composerFile && !state.pendingFlight) return;
    const btn = document.getElementById("composer-submit");
    btn.disabled = true;
    btn.textContent = "投稿中...";
    try {
      await createPost(text, state.composerFile, state.pendingFlight);
      textEl.value = "";
      state.composerFile = null;
      if (state.composerPreviewUrl) URL.revokeObjectURL(state.composerPreviewUrl);
      state.composerPreviewUrl = null;
      document.getElementById("composer-file-input").value = "";
      renderComposerPreview();
      state.pendingFlight = null;
      renderComposerFlightPreview();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "投稿";
    }
  }

  function renderFeedList() {
    renderFeedStats();
    const list = document.getElementById("feed-list");
    if (!list) return;
    if (!state.posts.length) {
      list.innerHTML = `<div class="empty-state">まだ投稿がありません。最初のフライトをシェアしよう ✈️</div>`;
      return;
    }
    list.innerHTML = state.posts.map(renderPostHtml).join("");
    attachFeedListeners();
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
  // separately from the main feed (see loadPopularFlights).
  function renderPopularFlights() {
    const slot = document.getElementById("popular-flights-slot");
    if (!slot) return;
    const list = state.popularFlights || [];
    if (!list.length) { slot.innerHTML = ""; return; }
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

  function renderPostHtml(post) {
    const mine = state.user && post.authorId === state.user.id;
    const isOpen = state.openComments.has(post.id);
    const comments = state.commentsByPost[post.id] || [];

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

        ${post.flight ? `
          <div class="flight-card flight-card-rich">
            ${flightCardHtml(post.flight)}
          </div>
        ` : ""}

        ${post.imageUrl ? `<img class="post-image" data-action="zoom" src="${escapeHtml(post.imageUrl)}" loading="lazy" alt="投稿画像" />` : ""}

        <div class="post-actions">
          <button class="action-btn ${post.likedByMe ? "liked" : ""}" data-action="like">
            ${post.likedByMe ? "❤️" : "🤍"} ${post.likeCount}
          </button>
          <button class="action-btn" data-action="toggle-comments">💬 ${post.commentCount}</button>
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

    const img = el.querySelector('[data-action="zoom"]');
    if (img) img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(img.src); });

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
        const input = commentForm.querySelector('input[name="text"]');
        const text = input.value;
        input.value = "";
        try {
          await postComment(postId, text);
          if (onChange) onChange();
        } catch (err) {
          toast(err.message);
        }
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
  async function openUserProfile(callsign) {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal" style="max-width:520px;">
        <button class="modal-close" id="profile-view-close">✕</button>
        <div id="profile-view-slot"><div class="spinner-row">読み込み中...</div></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("profile-view-close").addEventListener("click", () => overlay.remove());

    try {
      const [{ user, stats }, { posts }] = await Promise.all([
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

      const slot = document.getElementById("profile-view-slot");
      if (!slot) return;
      slot.innerHTML = `
        <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
          ${avatarHtml(user, 64)}
          <div>
            <div style="font-weight:700; font-size:17px;">${escapeHtml(user.name)}</div>
            <div style="color:var(--text-dim); font-size:13px;">@${escapeHtml(user.callsign)}${user.homeBase ? ` · ${escapeHtml(user.homeBase)}` : ""}</div>
          </div>
        </div>
        ${user.bio ? `<div style="margin-bottom:14px; font-size:14px;">${linkify(escapeHtml(user.bio))}</div>` : ""}
        <div style="display:flex; gap:22px; margin-bottom:16px; font-size:13px; color:var(--text-dim);">
          <div><b style="color:var(--accent-2); display:block; font-size:16px;">${stats.flights}</b>フライト</div>
          <div><b style="color:var(--accent-2); display:block; font-size:16px;">${stats.hours.toFixed(1)}</b>時間</div>
          <div><b style="color:var(--accent-2); display:block; font-size:16px;">${Math.round(stats.distanceNm)}</b>nm</div>
        </div>
        <div id="profile-view-posts"></div>
      `;

      const postIds = posts.map((p) => p.id);

      function renderProfilePosts() {
        const postsSlot = document.getElementById("profile-view-posts");
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

      renderProfilePosts();
    } catch (err) {
      const slot = document.getElementById("profile-view-slot");
      if (slot) slot.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
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

    document.getElementById("profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const saveBtn = document.getElementById("profile-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中...";
      try {
        await updateProfile({
          name: fd.get("name"),
          homeBase: fd.get("homeBase"),
          bio: fd.get("bio"),
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

  boot();
})();
