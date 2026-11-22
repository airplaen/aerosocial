// AeroSocial — VATSIM / VATJPN イベント連携
// ---------------------------------------------------------------------
// 既存のイベントモーダル (app.js の openEventsModal) に「VATSIM」と
// 「VATJPN」タブを追加する独立スクリプト。app.js 本体は無改造。
// データは VATSIM 公式の公開API (myVATSIM) からブラウザが直接取得する。
//   GET https://my.vatsim.net/api/v2/events
// VATJPNタブは、主催ディビジョン / 空港 (RJ**) / 名称から日本の
// イベントを抽出して表示する。
// 取得に失敗した場合は、公式イベントページへのリンクを表示する。
(() => {
  "use strict";

  const API_URL = "https://my.vatsim.net/api/v2/events";
  const VATSIM_EVENTS_PAGE = "https://my.vatsim.net/events";
  const VATJPN_SITE = "https://www.vatjpn.org/";
  const CACHE_KEY = "aerosocial-vatsim-events-v1";
  const CACHE_TTL_MS = 10 * 60 * 1000;

  let memCache = null; // { at: number, events: Array }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalize(payload) {
    const list = Array.isArray(payload)
      ? payload
      : payload?.data || payload?.events || [];
    const now = Date.now();
    return list
      .map((ev) => {
        const airports = (ev.airports || [])
          .map((a) => (typeof a === "string" ? a : a?.icao || a?.code || ""))
          .filter(Boolean);
        const orgText = (ev.organisers || ev.organizers || [])
          .map((o) =>
            [o?.region, o?.division, o?.subdivision, o?.organisation, o?.organization]
              .filter(Boolean)
              .join(" ")
          )
          .join(" ");
        const start = new Date(ev.start_time || ev.startTime || ev.starts_at || "");
        const end = new Date(ev.end_time || ev.endTime || ev.ends_at || "");
        return {
          name: ev.name || ev.title || "イベント",
          link: ev.link || ev.url || VATSIM_EVENTS_PAGE,
          banner: ev.banner || ev.image || "",
          airports,
          orgText,
          start,
          end,
        };
      })
      .filter((ev) => !Number.isNaN(ev.start.getTime()))
      .filter((ev) => (Number.isNaN(ev.end.getTime()) ? ev.start.getTime() : ev.end.getTime()) >= now)
      .sort((a, b) => a.start - b.start);
  }

  function isJapanEvent(ev) {
    if (/vatjpn|japan/i.test(ev.orgText)) return true;
    if (ev.airports.some((icao) => /^RJ[A-Z]{2}$/i.test(icao))) return true;
    if (/vatjpn|japan|日本/i.test(ev.name)) return true;
    return false;
  }

  async function fetchEvents() {
    if (memCache && Date.now() - memCache.at < CACHE_TTL_MS) return memCache.events;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.at < CACHE_TTL_MS && Array.isArray(parsed.events)) {
          memCache = { at: parsed.at, events: parsed.events.map(revive) };
          return memCache.events;
        }
      }
    } catch (_) { /* cache is best-effort */ }

    const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`VATSIM API error: ${res.status}`);
    const events = normalize(await res.json());
    memCache = { at: Date.now(), events };
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: memCache.at, events }));
    } catch (_) { /* ignore quota errors */ }
    return events;
  }

  function revive(ev) {
    return { ...ev, start: new Date(ev.start), end: new Date(ev.end) };
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
    const jst = fmtJst.format(ev.start);
    const z = fmtZulu.format(ev.start);
    if (!Number.isNaN(ev.end.getTime())) {
      return `${jst} – ${fmtJst.format(ev.end)} JST（${z}Z〜）`;
    }
    return `${jst} JST（${z}Z）`;
  }

  function cardHtml(ev, mode) {
    const badge = mode === "vatjpn" ? "🗾 VATJPN" : "🌐 VATSIM";
    const route = ev.airports.length ? ev.airports.join(" · ") : "オンライン開催";
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
          ${ev.orgText ? `<span>🏢 ${escapeHtml(ev.orgText)}</span>` : ""}
        </div>
        <div class="event-card-bottom">
          <span class="event-card-creator">VATSIM公式イベント</span>
          <a class="btn btn-primary" style="padding:5px 12px; font-size:12px; text-decoration:none;"
             href="${escapeHtml(ev.link)}" target="_blank" rel="noopener noreferrer">詳細を見る</a>
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
        const all = await fetchEvents();
        const events = mode === "vatjpn" ? all.filter(isJapanEvent) : all;
        if (!events.length) {
          listSlot.innerHTML = `<div class="empty-state">${
            mode === "vatjpn"
              ? "現在予定されている VATJPN（日本）のイベントはありません。"
              : "現在予定されている VATSIM イベントはありません。"
          }</div>`;
          return;
        }
        listSlot.innerHTML =
          events.map((ev) => cardHtml(ev, mode)).join("") +
          `<div class="empty-state" style="border:none; padding:12px;">出典: <a href="${VATSIM_EVENTS_PAGE}" target="_blank" rel="noopener noreferrer">myVATSIM イベント一覧</a>${
            mode === "vatjpn"
              ? ` / <a href="${VATJPN_SITE}" target="_blank" rel="noopener noreferrer">VATJPN 公式サイト</a>`
              : ""
          }</div>`;
      } catch (err) {
        listSlot.innerHTML = `
          <div class="error-banner">VATSIMイベントを取得できませんでした。時間をおいて再度お試しください。</div>
          <div class="empty-state" style="margin-top:10px;">公式ページで確認できます: <a href="${VATSIM_EVENTS_PAGE}" target="_blank" rel="noopener noreferrer">myVATSIM イベント一覧</a>${
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
})();
