// AeroSocial — VATSIM / VATJPN イベント連携 (フロント)
// ---------------------------------------------------------------------
// 既存のイベントモーダル (app.js の openEventsModal) に「VATSIM」と
// 「VATJPN」タブを追加する独立スクリプト。app.js 本体は無改造。
// データは自サーバーの /api/vatsim/events から取得する (サーバー側が
// VATSIM公式 Events API を15分ごとに自動取得・キャッシュしている)。
(() => {
  "use strict";

  const API_BASE = "/api/vatsim/events";
  const VATSIM_EVENTS_PAGE = "https://www.vatsim.net/events";
  const VATJPN_SITE = "https://www.vatjpn.org/";

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const fmtJst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const fmtZulu = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });

  function whenLabel(ev) {
    const start = new Date(ev.startTime);
    if (Number.isNaN(start.getTime())) return "";
    const end = ev.endTime ? new Date(ev.endTime) : null;
    const jst = fmtJst.format(start);
    const z = fmtZulu.format(start);
    if (end && !Number.isNaN(end.getTime())) {
      return `${jst} – ${fmtJst.format(end)} JST（${z}Z〜）`;
    }
    return `${jst} JST（${z}Z）`;
  }

  function cardHtml(ev, mode) {
    const badge = mode === "vatjpn" ? "🗾 VATJPN" : "🌐 VATSIM";
    const route = ev.airports?.length ? ev.airports.join(" · ") : "オンライン開催";
    const banner = ev.banner
      ? `<img class="vatsim-banner" src="${escapeHtml(ev.banner)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : "";
    return `
      <div class="event-card vatsim-event-card">
        ${banner}
        <div class="event-card-top">
          <span class="event-type-badge">${badge}</span>
          <span class="event-card-when">${escapeHtml(whenLabel(ev))}</span>
        </div>
        <div class="event-card-title">${escapeHtml(ev.name)}</div>
        <div class="event-card-meta">
          <span>📍 ${escapeHtml(route)}</span>
          ${ev.organisers ? `<span>🏢 ${escapeHtml(ev.organisers)}</span>` : ""}
        </div>
        <div class="event-card-bottom">
          <span class="event-card-creator">VATSIM公式イベント</span>
          <a class="btn btn-primary" style="padding:5px 12px; font-size:12px; text-decoration:none;"
             href="${escapeHtml(ev.link || VATSIM_EVENTS_PAGE)}" target="_blank" rel="noopener noreferrer">詳細を見る</a>
        </div>
      </div>
    `;
  }

  function enhanceEventsModal(modal) {
    if (!modal || modal.dataset.vatsimEnhanced) return;
    const tabs = modal.querySelector(".tabs");
    const listSlot = modal.querySelector("#event-list-slot");
    if (!tabs || !listSlot) return;
    modal.dataset.vatsimEnhanced = "1";

    const createToggle = modal.querySelector("#event-create-toggle");
    const createWrap = createToggle ? createToggle.parentElement : null;
    const createSlot = modal.querySelector("#event-create-slot");

    const modes = [
      { id: "vatsim", label: "🌐 VATSIM" },
      { id: "vatjpn", label: "🗾 VATJPN" },
    ];
    const extButtons = modes.map((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = m.label;
      btn.dataset.extTab = m.id;
      btn.addEventListener("click", () => activateExt(m.id));
      tabs.appendChild(btn);
      return btn;
    });

    function setActive(activeBtn) {
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === activeBtn));
    }

    function setCreateVisible(visible) {
      if (createWrap) createWrap.style.display = visible ? "" : "none";
      if (createSlot) createSlot.style.display = visible ? "" : "none";
    }

    async function activateExt(mode) {
      const btn = extButtons[modes.findIndex((m) => m.id === mode)];
      setActive(btn);
      setCreateVisible(false);
      listSlot.innerHTML = `<div class="spinner-row">VATSIMイベントを読み込み中...</div>`;
      try {
        const res = await fetch(`${API_BASE}?scope=${mode === "vatjpn" ? "vatjpn" : "all"}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { events } = await res.json();
        if (!events?.length) {
          listSlot.innerHTML = `<div class="empty-state">${
            mode === "vatjpn"
              ? "現在予定されている VATJPN（日本）のイベントはありません。"
              : "現在予定されている VATSIM イベントはありません。"
          }</div>`;
          return;
        }
        listSlot.innerHTML =
          events.map((ev) => cardHtml(ev, mode)).join("") +
          `<div class="empty-state" style="border:none; padding:12px;">出典: <a href="${VATSIM_EVENTS_PAGE}" target="_blank" rel="noopener noreferrer">VATSIM 公式イベント一覧</a>${
            mode === "vatjpn"
              ? ` / <a href="${VATJPN_SITE}" target="_blank" rel="noopener noreferrer">VATJPN 公式サイト</a>`
              : ""
          }</div>`;
      } catch (err) {
        listSlot.innerHTML = `
          <div class="error-banner">VATSIMイベントを取得できませんでした。時間をおいて再度お試しください。</div>
          <div class="empty-state" style="margin-top:10px;">公式ページで確認できます: <a href="${VATSIM_EVENTS_PAGE}" target="_blank" rel="noopener noreferrer">VATSIM 公式イベント一覧</a>${
            mode === "vatjpn"
              ? ` / <a href="${VATJPN_SITE}" target="_blank" rel="noopener noreferrer">VATJPN 公式サイト</a>`
              : ""
          }</div>`;
      }
    }

    // アプリ側のタブ (開催予定 / 過去) に戻ったら作成ボタンを復帰させる。
    tabs.querySelectorAll("button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setCreateVisible(true));
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.classList?.contains("modal-backdrop")) {
          enhanceEventsModal(node.querySelector(".events-modal"));
        } else if (node.querySelector?.(".events-modal")) {
          enhanceEventsModal(node.querySelector(".events-modal"));
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });

  // 既に開いているモーダルがあればそれも対象にする。
  enhanceEventsModal(document.querySelector(".events-modal"));

  // ---- 右サイドバーのミニパネル (直近のVATSIMイベント) ----
  const fmtMini = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  function isJapan(ev) {
    if ((ev.divisions || []).includes("VATJPN")) return true;
    if ((ev.airports || []).some((icao) => /^RJ/i.test(icao))) return true;
    return /japan/i.test(ev.organisers || "");
  }

  async function loadMiniPanel(panel) {
    const body = panel.querySelector(".vatsim-mini-body");
    if (!body) return;
    try {
      const res = await fetch(`${API_BASE}?scope=all`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { events } = await res.json();
      if (!events?.length) {
        body.innerHTML = `<div class="vatsim-mini-empty">予定されているイベントはありません</div>`;
        return;
      }
      body.innerHTML = events
        .slice(0, 3)
        .map((ev) => {
          const when = fmtMini.format(new Date(ev.startTime));
          const route = ev.airports?.length ? ev.airports.join(" → ") : "";
          return `<a class="vatsim-mini-item" href="${escapeHtml(ev.link || VATSIM_EVENTS_PAGE)}" target="_blank" rel="noopener noreferrer">
            <span class="vatsim-mini-when">${escapeHtml(when)}${isJapan(ev) ? " 🗾" : ""}</span>
            <span class="vatsim-mini-name">${escapeHtml(ev.name)}</span>
            ${route ? `<span class="vatsim-mini-route">${escapeHtml(route)}</span>` : ""}
          </a>`;
        })
        .join("");
    } catch (_) {
      body.innerHTML = `<div class="vatsim-mini-empty">取得できませんでした</div>`;
    }
  }

  function injectMiniPanel() {
    if (document.getElementById("vatsim-mini-panel")) return;
    const popular = document.querySelector(".popular-flights");
    if (!popular || !popular.parentElement) return;
    const panel = document.createElement("div");
    panel.className = "panel vatsim-mini-panel";
    panel.id = "vatsim-mini-panel";
    panel.innerHTML = `<div class="vatsim-mini-head">🛩 VATSIMイベント</div><div class="vatsim-mini-body"><div class="vatsim-mini-empty">読み込み中...</div></div>`;
    popular.parentElement.insertBefore(panel, popular.nextSibling);
    loadMiniPanel(panel);
  }

  let injectTimer = null;
  const shellObserver = new MutationObserver(() => {
    if (injectTimer) return;
    injectTimer = setTimeout(() => {
      injectTimer = null;
      injectMiniPanel();
    }, 300);
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
  injectMiniPanel();

  // サーバー側の自動更新 (15分) に合わせてパネルも更新する。
  setInterval(() => {
    const panel = document.getElementById("vatsim-mini-panel");
    if (panel) loadMiniPanel(panel);
  }, 15 * 60 * 1000);
})();
