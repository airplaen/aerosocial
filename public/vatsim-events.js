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

  // ---- イベント詳細ポップアップ ----
  // カード/ミニパネルの項目をクリックしたときに、その場でちょっとした
  // 詳細 (バナー・日時・空港・主催・概要) を出す。公式ページへの
  // リンクはポップアップ内のボタンから開く。
  function openVatsimDetail(ev, mode) {
    document.querySelector(".vatsim-detail-backdrop")?.remove();
    const badge = mode === "vatjpn"
      ? "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>flag</span> VATJPN"
      : "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>public</span> VATSIM";
    const route = ev.airports?.length ? ev.airports.join(" · ") : "オンライン開催";
    const banner = ev.banner
      ? `<img class="vatsim-detail-banner" src="${escapeHtml(ev.banner)}" alt="" referrerpolicy="no-referrer" />`
      : "";
    // shortDescription は公式フィード由来のHTML断片なので、タグを取り除いて
    // プレーンテキスト化してから表示する (escapeHtml で再度エスケープされる)。
    const desc = (ev.shortDescription || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop vatsim-detail-backdrop";
    overlay.innerHTML = `
      <div class="modal vatsim-detail-modal" role="dialog" aria-modal="true" aria-label="イベント詳細">
        <button type="button" class="modal-close" aria-label="閉じる">✕</button>
        ${banner}
        <span class="event-type-badge">${badge}</span>
        <h3 class="vatsim-detail-title">${escapeHtml(ev.name)}</h3>
        <div class="vatsim-detail-rows">
          <div><span class="material-symbols-rounded ui-ic" aria-hidden="true">schedule</span> ${escapeHtml(whenLabel(ev))}</div>
          <div><span class="material-symbols-rounded ui-ic" aria-hidden="true">location_on</span> ${escapeHtml(route)}</div>
          ${ev.organisers ? `<div><span class="material-symbols-rounded ui-ic" aria-hidden="true">business</span> ${escapeHtml(ev.organisers)}</div>` : ""}
        </div>
        ${desc ? `<p class="vatsim-detail-desc">${escapeHtml(desc)}</p>` : ""}
        <a class="btn btn-primary btn-block" href="${escapeHtml(ev.link || VATSIM_EVENTS_PAGE)}" target="_blank" rel="noopener noreferrer">VATSIM公式ページで詳細を見る</a>
      </div>
    `;
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".modal-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  function cardHtml(ev, mode, idx) {
    const badge = mode === "vatjpn" ? "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>flag</span> VATJPN" : "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>public</span> VATSIM";
    const route = ev.airports?.length ? ev.airports.join(" · ") : "オンライン開催";
    const banner = ev.banner
      ? `<img class="vatsim-banner" src="${escapeHtml(ev.banner)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : "";
    return `
      <div class="event-card vatsim-event-card" data-vatsim-idx="${idx}" title="クリックで詳細を表示">
        ${banner}
        <div class="event-card-top">
          <span class="event-type-badge">${badge}</span>
          <span class="event-card-when">${escapeHtml(whenLabel(ev))}</span>
        </div>
        <div class="event-card-title">${escapeHtml(ev.name)}</div>
        <div class="event-card-meta">
          <span><span class="material-symbols-rounded ui-ic" aria-hidden="true">location_on</span> ${escapeHtml(route)}</span>
          ${ev.organisers ? `<span><span class="material-symbols-rounded ui-ic" aria-hidden="true">business</span> ${escapeHtml(ev.organisers)}</span>` : ""}
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
      { id: "vatsim", label: "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>public</span> VATSIM" },
      { id: "vatjpn", label: "<span class='material-symbols-rounded ui-ic' aria-hidden='true'>flag</span> VATJPN" },
    ];
    const extButtons = modes.map((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = m.label;
      btn.dataset.extTab = m.id;
      btn.addEventListener("click", () => activateExt(m.id));
      tabs.appendChild(btn);
      return btn;
    });

    // 現在表示中のVATSIMイベント一覧。カードのクリックで詳細を出すために保持する。
    let currentEvents = [];
    let currentMode = "vatsim";
    listSlot.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // 「詳細を見る」などのリンクはそのまま
      const card = e.target.closest(".vatsim-event-card");
      if (!card) return;
      const ev = currentEvents[Number(card.dataset.vatsimIdx)];
      if (ev) openVatsimDetail(ev, currentMode);
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
        currentEvents = events;
        currentMode = mode;
        listSlot.innerHTML =
          events.map((ev, i) => cardHtml(ev, mode, i)).join("") +
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
      panel._miniEvents = events.slice(0, 3);
      body.innerHTML = panel._miniEvents
        .map((ev, i) => {
          const when = fmtMini.format(new Date(ev.startTime));
          const route = ev.airports?.length ? ev.airports.join(" → ") : "";
          return `<a class="vatsim-mini-item" data-mini-idx="${i}" href="${escapeHtml(ev.link || VATSIM_EVENTS_PAGE)}" target="_blank" rel="noopener noreferrer">
            <span class="vatsim-mini-when">${escapeHtml(when)}${isJapan(ev) ? " <span class='material-symbols-rounded ui-ic' aria-hidden='true'>flag</span>" : ""}</span>
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
    panel.innerHTML = `<div class="vatsim-mini-head"><span class="material-symbols-rounded ui-ic" aria-hidden="true">flight</span> VATSIMイベント</div><div class="vatsim-mini-body"><div class="vatsim-mini-empty">読み込み中...</div></div>`;
    // 項目クリックで詳細ポップアップを出す (公式ページへはポップアップ内から)。
    panel.addEventListener("click", (e) => {
      const item = e.target.closest(".vatsim-mini-item");
      if (!item) return;
      const ev = (panel._miniEvents || [])[Number(item.dataset.miniIdx)];
      if (!ev) return;
      e.preventDefault();
      openVatsimDetail(ev, isJapan(ev) ? "vatjpn" : "vatsim");
    });
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
