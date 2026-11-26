// AeroSocial — ストーリー機能 (フロント)
// ---------------------------------------------------------------------
// 24時間で消える投稿。app.js 本体は無改造で、vatsim-events.js と同じ
// 「独立スクリプト」方式: MutationObserver でフィード列 (.feed-column)
// の出現を検知し、投稿欄の上にストーリーバー (#stories-bar) を差し込む。
// 認証は app.js と同じ localStorage のトークンをそのまま使う。
// リアルタイム更新は自前の WebSocket (story:new / story:deleted) で受ける。
(() => {
  "use strict";

  const TOKEN_KEY = "aerosocial_token";
  const API_BASE = "/api/stories";
  const TEXT_MAX_LEN = 200;
  const STORY_DURATION_MS = 5000;
  const HUE_PRESETS = [210, 265, 160, 20, 340, 45];

  const state = {
    groups: [],
    me: null,
    loaded: false,
  };

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (!(options.body instanceof FormData) && options.body) headers["Content-Type"] = "application/json";
    const t = token();
    if (t) headers["Authorization"] = `Bearer ${t}`;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error((data && data.error) || `エラーが発生しました (${res.status})`);
    return data;
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diffMin = Math.floor((Date.now() - d) / 60000);
    if (diffMin < 1) return "たった今";
    if (diffMin < 60) return `${diffMin}分前`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}時間前`;
    return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  }

  function remainingLabel(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return "まもなく消えます";
    const h = Math.floor(ms / 3600000);
    if (h >= 1) return `あと${h}時間で消えます`;
    return `あと${Math.max(1, Math.floor(ms / 60000))}分で消えます`;
  }

  function avatarInner(user, size) {
    if (user.avatarUrl) {
      return `<img class="avatar" style="width:${size}px;height:${size}px;" src="${escapeHtml(user.avatarUrl)}" alt="" />`;
    }
    const hue = Number.isFinite(user.hue) ? user.hue : 200;
    const initial = (user.name || user.callsign || "?").trim().charAt(0).toUpperCase();
    return `<div class="avatar avatar-fallback" style="width:${size}px;height:${size}px;background:hsl(${hue} 70% 55%)">${escapeHtml(initial)}</div>`;
  }

  // ---------------------------------------------------------------- バー
  function barHtml() {
    const cells = [];
    if (state.me) {
      cells.push(`
        <button type="button" class="story-cell story-cell-add" id="story-add-btn" title="ストーリーを追加">
          <span class="story-ring story-ring-add">${avatarInner(state.me, 56)}<span class="story-add-badge">＋</span></span>
          <span class="story-cell-name">ストーリー</span>
        </button>`);
    }
    state.groups.forEach((group, i) => {
      const mine = state.me && group.user.id === state.me.id;
      const ringClass = mine ? "story-ring-mine" : (group.hasUnseen ? "story-ring-unseen" : "story-ring-seen");
      cells.push(`
        <button type="button" class="story-cell" data-story-group="${i}" title="${escapeHtml(group.user.name)}のストーリー">
          <span class="story-ring ${ringClass}">${avatarInner(group.user, 56)}</span>
          <span class="story-cell-name">${escapeHtml(mine ? "あなた" : group.user.name)}</span>
        </button>`);
    });
    return cells.join("");
  }

  function renderBar() {
    const bar = document.getElementById("stories-bar");
    if (!bar) return;
    if (!state.me && !state.groups.length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    bar.innerHTML = barHtml();
    bar.querySelector("#story-add-btn")?.addEventListener("click", openStoryComposer);
    bar.querySelectorAll("[data-story-group]").forEach((btn) => {
      btn.addEventListener("click", () => openStoryViewer(Number(btn.dataset.storyGroup), 0));
    });
  }

  async function loadStories() {
    try {
      const { groups } = await api(API_BASE);
      state.groups = groups || [];
    } catch {
      state.groups = [];
    }
    state.loaded = true;
    renderBar();
  }

  async function loadMe() {
    if (!token()) { state.me = null; return; }
    try {
      const { user } = await api("/api/users/me");
      state.me = user;
    } catch {
      state.me = null;
    }
  }

  function ensureBar() {
    const feedColumn = document.querySelector(".feed-column");
    if (!feedColumn || document.getElementById("stories-bar")) return;
    const bar = document.createElement("div");
    bar.id = "stories-bar";
    bar.className = "stories-bar";
    const composer = feedColumn.querySelector("#composer");
    if (composer) feedColumn.insertBefore(bar, composer);
    else feedColumn.prepend(bar);
    renderBar();
    if (!state.loaded) { loadMe().then(loadStories); }
  }

  const observer = new MutationObserver(() => ensureBar());
  observer.observe(document.body, { childList: true, subtree: true });
  ensureBar();

  // ---------------------------------------------------------------- 投稿
  function openStoryComposer() {
    if (!state.me) { toast("ストーリーの投稿にはログインが必要です。"); return; }
    document.querySelector(".story-composer-backdrop")?.remove();

    let selectedHue = Number.isFinite(state.me.hue) ? state.me.hue : HUE_PRESETS[0];
    let imageFile = null;
    let previewUrl = null;

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop story-composer-backdrop";
    overlay.innerHTML = `
      <div class="modal story-composer-modal">
        <button class="modal-close" id="story-composer-close">✕</button>
        <h2>ストーリーを投稿</h2>
        <p class="story-composer-note">24時間で自動的に消えます。画像・テキストどちらか（または両方）をどうぞ。</p>
        <div class="story-preview" id="story-preview">
          <div class="story-preview-text" id="story-preview-text">テキストを入力するとここに表示されます</div>
          <img class="story-preview-img hidden" id="story-preview-img" alt="" />
        </div>
        <textarea id="story-text" maxlength="${TEXT_MAX_LEN}" rows="3" placeholder="いまの空模様は？（最大${TEXT_MAX_LEN}文字）"></textarea>
        <div class="story-composer-row">
          <div class="story-hues" id="story-hues">
            ${HUE_PRESETS.map((h) => `<button type="button" class="story-hue" data-hue="${h}" style="background:linear-gradient(135deg,hsl(${h} 75% 55%),hsl(${h + 40} 75% 45%))" aria-label="背景色 ${h}"></button>`).join("")}
          </div>
          <span class="story-char-count" id="story-char-count">0/${TEXT_MAX_LEN}</span>
        </div>
        <div class="story-composer-row">
          <button type="button" class="btn btn-ghost" id="story-pick-image"><span class="material-symbols-rounded ui-ic" aria-hidden="true">image</span> 画像を選ぶ</button>
          <button type="button" class="btn btn-ghost hidden" id="story-remove-image">画像を外す</button>
          <input type="file" id="story-file-input" accept="image/*" class="hidden-file-input" />
          <button type="button" class="btn btn-primary" id="story-submit">投稿する</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const preview = overlay.querySelector("#story-preview");
    const previewText = overlay.querySelector("#story-preview-text");
    const previewImg = overlay.querySelector("#story-preview-img");
    const textInput = overlay.querySelector("#story-text");
    const charCount = overlay.querySelector("#story-char-count");
    const submitBtn = overlay.querySelector("#story-submit");

    function paintPreview() {
      preview.style.background = `linear-gradient(160deg, hsl(${selectedHue} 72% 52%), hsl(${selectedHue + 45} 72% 40%))`;
      const text = textInput.value.trim();
      previewText.textContent = text || (imageFile ? "" : "テキストを入力するとここに表示されます");
      previewText.style.display = imageFile && !text ? "none" : "";
      overlay.querySelectorAll(".story-hue").forEach((b) => b.classList.toggle("selected", Number(b.dataset.hue) === selectedHue));
    }
    paintPreview();

    function close() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      overlay.remove();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#story-composer-close").addEventListener("click", close);

    textInput.addEventListener("input", () => {
      charCount.textContent = `${textInput.value.length}/${TEXT_MAX_LEN}`;
      paintPreview();
    });
    overlay.querySelectorAll(".story-hue").forEach((b) => {
      b.addEventListener("click", () => { selectedHue = Number(b.dataset.hue); paintPreview(); });
    });
    overlay.querySelector("#story-pick-image").addEventListener("click", () => overlay.querySelector("#story-file-input").click());
    overlay.querySelector("#story-file-input").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      imageFile = file;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      previewImg.src = previewUrl;
      previewImg.classList.remove("hidden");
      overlay.querySelector("#story-remove-image").classList.remove("hidden");
      paintPreview();
    });
    overlay.querySelector("#story-remove-image").addEventListener("click", () => {
      imageFile = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      previewImg.classList.add("hidden");
      previewImg.removeAttribute("src");
      overlay.querySelector("#story-remove-image").classList.add("hidden");
      paintPreview();
    });

    submitBtn.addEventListener("click", async () => {
      const text = textInput.value.trim();
      if (!text && !imageFile) { toast("画像かテキストのどちらかは必要です。"); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = "投稿中...";
      try {
        const form = new FormData();
        if (imageFile) form.append("image", imageFile);
        if (text) form.append("text", text);
        form.append("hue", String(selectedHue));
        await api(API_BASE, { method: "POST", body: form });
        close();
        toast("ストーリーを投稿しました（24時間で消えます）。");
        await loadStories();
      } catch (err) {
        toast(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = "投稿する";
      }
    });

    textInput.focus();
  }

  // ---------------------------------------------------------------- ビューア
  function openStoryViewer(groupIndex, storyIndex) {
    document.querySelector(".story-viewer-backdrop")?.remove();
    let g = groupIndex;
    let s = storyIndex;
    let timer = null;
    let progressTimer = null;

    const overlay = document.createElement("div");
    overlay.className = "story-viewer-backdrop";
    overlay.innerHTML = `
      <div class="story-viewer">
        <div class="story-viewer-progress" id="story-progress"></div>
        <div class="story-viewer-head">
          <span id="story-viewer-author"></span>
          <span class="story-viewer-head-actions">
            <button type="button" class="story-viewer-icon-btn hidden" id="story-viewers-btn" title="閲覧者"><span class="material-symbols-rounded" aria-hidden="true">visibility</span> <span id="story-view-count"></span></button>
            <button type="button" class="story-viewer-icon-btn hidden" id="story-delete-btn" title="このストーリーを削除"><span class="material-symbols-rounded" aria-hidden="true">delete</span></button>
            <button type="button" class="story-viewer-icon-btn" id="story-viewer-close" title="閉じる">✕</button>
          </span>
        </div>
        <div class="story-viewer-body" id="story-viewer-body"></div>
        <div class="story-viewer-foot" id="story-viewer-foot"></div>
        <button type="button" class="story-nav-zone story-nav-prev" id="story-prev" aria-label="前へ"></button>
        <button type="button" class="story-nav-zone story-nav-next" id="story-next" aria-label="次へ"></button>
        <div class="story-viewers-panel hidden" id="story-viewers-panel"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const progressEl = overlay.querySelector("#story-progress");
    const authorEl = overlay.querySelector("#story-viewer-author");
    const bodyEl = overlay.querySelector("#story-viewer-body");
    const footEl = overlay.querySelector("#story-viewer-foot");
    const viewersBtn = overlay.querySelector("#story-viewers-btn");
    const viewersPanel = overlay.querySelector("#story-viewers-panel");
    const deleteBtn = overlay.querySelector("#story-delete-btn");

    function current() {
      const group = state.groups[g];
      if (!group) return null;
      return { group, story: group.stories[s] };
    }

    function stopTimers() {
      if (timer) clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      timer = null; progressTimer = null;
    }

    function close() {
      stopTimers();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      renderBar();
    }

    function go(delta) {
      const group = state.groups[g];
      if (!group) { close(); return; }
      let ng = g, ns = s + delta;
      if (ns >= group.stories.length) { ng = g + 1; ns = 0; }
      if (ns < 0) {
        ng = g - 1;
        if (ng < 0) { show(); return; }
        ns = state.groups[ng].stories.length - 1;
      }
      if (ng >= state.groups.length) { close(); return; }
      g = ng; s = ns;
      show();
    }

    function show() {
      const cur = current();
      if (!cur) { close(); return; }
      const { group, story } = cur;
      const mine = state.me && story.authorId === state.me.id;

      progressEl.innerHTML = group.stories.map((_, i) =>
        `<span class="story-progress-seg"><span class="story-progress-fill" data-seg="${i}" style="width:${i < s ? 100 : 0}%"></span></span>`).join("");
      authorEl.innerHTML = `${avatarInner(group.user, 32)}<span class="story-viewer-name">${escapeHtml(group.user.name)}</span><span class="story-viewer-time">${fmtTime(story.createdAt)}</span>`;
      bodyEl.style.background = story.imageUrl
        ? "#000"
        : `linear-gradient(160deg, hsl(${story.hue} 72% 52%), hsl(${story.hue + 45} 72% 40%))`;
      bodyEl.innerHTML = `
        ${story.imageUrl ? `<img class="story-viewer-img" src="${escapeHtml(story.imageUrl)}" alt="" />` : ""}
        ${story.text ? `<div class="story-viewer-text${story.imageUrl ? " story-viewer-text-overlay" : ""}">${escapeHtml(story.text)}</div>` : ""}`;
      footEl.textContent = remainingLabel(story.expiresAt);
      viewersPanel.classList.add("hidden");
      viewersPanel.innerHTML = "";

      viewersBtn.classList.toggle("hidden", !mine);
      deleteBtn.classList.toggle("hidden", !mine);
      if (mine) overlay.querySelector("#story-view-count").textContent = story.viewCount ?? 0;

      if (!mine && state.me && !story.viewedByMe) {
        story.viewedByMe = true;
        group.hasUnseen = group.stories.some((x) => !x.viewedByMe);
        api(`${API_BASE}/${encodeURIComponent(story.id)}/view`, { method: "POST" }).catch(() => {});
      }

      stopTimers();
      const startedAt = Date.now();
      progressTimer = setInterval(() => {
        const fill = progressEl.querySelector(`[data-seg="${s}"]`);
        if (fill) fill.style.width = `${Math.min(100, ((Date.now() - startedAt) / STORY_DURATION_MS) * 100)}%`;
      }, 50);
      timer = setTimeout(() => go(1), STORY_DURATION_MS);
    }

    viewersBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cur = current();
      if (!cur) return;
      if (!viewersPanel.classList.contains("hidden")) { viewersPanel.classList.add("hidden"); return; }
      viewersPanel.innerHTML = `<div class="story-viewers-title">閲覧者</div><div class="story-viewers-loading">読み込み中...</div>`;
      viewersPanel.classList.remove("hidden");
      try {
        const { viewers } = await api(`${API_BASE}/${encodeURIComponent(cur.story.id)}/viewers`);
        viewersPanel.innerHTML = `<div class="story-viewers-title">閲覧者（${viewers.length}人）</div>` +
          (viewers.length
            ? viewers.map((v) => `<div class="story-viewer-row">${avatarInner(v, 28)}<span>${escapeHtml(v.name)}</span><span class="story-viewer-row-time">${fmtTime(v.viewedAt)}</span></div>`).join("")
            : `<div class="story-viewers-loading">まだ誰も見ていません</div>`);
      } catch (err) {
        viewersPanel.innerHTML = `<div class="story-viewers-loading">${escapeHtml(err.message)}</div>`;
      }
    });

    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cur = current();
      if (!cur) return;
      stopTimers();
      try {
        await api(`${API_BASE}/${encodeURIComponent(cur.story.id)}`, { method: "DELETE" });
        toast("ストーリーを削除しました。");
        await loadStories();
        if (!state.groups[g] || !state.groups[g].stories.length) { close(); return; }
        if (s >= state.groups[g].stories.length) s = state.groups[g].stories.length - 1;
        show();
      } catch (err) {
        toast(err.message);
        show();
      }
    });

    overlay.querySelector("#story-viewer-close").addEventListener("click", close);
    overlay.querySelector("#story-prev").addEventListener("click", () => go(-1));
    overlay.querySelector("#story-next").addEventListener("click", () => go(1));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    document.addEventListener("keydown", onKey);

    show();
  }

  // ---------------------------------------------------------------- リアルタイム
  let wsRetryMs = 3000;
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const t = token();
    const ws = new WebSocket(`${proto}//${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`);
    ws.onopen = () => { wsRetryMs = 3000; };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === "story:new" || msg.type === "story:deleted") {
        if (!document.querySelector(".story-viewer-backdrop")) loadStories();
      }
    };
    ws.onclose = () => {
      setTimeout(connectWs, wsRetryMs);
      wsRetryMs = Math.min(wsRetryMs * 2, 60000);
    };
    ws.onerror = () => ws.close();
  }
  connectWs();
})();
