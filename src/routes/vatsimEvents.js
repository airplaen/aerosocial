// src/routes/vatsimEvents.js
//
// VATSIM / VATJPN イベント連携。VATSIM公式 Events API
// (https://vatsim.net/api/events — vatsim.dev の Events API ドキュメント
// 参照) をサーバー側で取得し、正規化して返す読み取り専用API。
// ブラウザから直接叩くとCORSで弾かれるため、必ずこのプロキシ経由にする。
//
// 自動更新: 起動時に1回取得し、以降15分ごとにバックグラウンドで
// 再取得してキャッシュを差し替える。取得に失敗した場合は前回の
// キャッシュを返し続ける (空にはしない)。ログイン不要 (ニュースや
// 地震パネルと同じ方針)。
const express = require("express");

const router = express.Router();

const FEED_URL = "https://vatsim.net/api/events";
const REFRESH_MS = 15 * 60 * 1000;

let cache = { at: 0, events: [] };
let inflight = null;

function normalizeEvent(ev) {
  const airports = (ev.airports || [])
    .map((a) => (typeof a === "string" ? a : a?.icao || ""))
    .filter(Boolean);
  const orgParts = (ev.organisers || []).map((o) =>
    [o?.region, o?.division, o?.subdivision].filter(Boolean).join(" / ")
  );
  const divisions = (ev.organisers || [])
    .map((o) => String(o?.division || "").toUpperCase())
    .filter(Boolean);
  return {
    name: ev.name || "イベント",
    link: ev.link || "https://www.vatsim.net/events",
    banner: ev.bannerLink || ev.banner || "",
    shortDescription: ev.shortDescription || "",
    startTime: ev.startTime || ev.start_time || null,
    endTime: ev.endTime || ev.end_time || null,
    airports,
    organisers: orgParts.join(", "),
    divisions,
  };
}

function isJapanEvent(ev) {
  if (ev.divisions.includes("VATJPN")) return true;
  if (/japan/i.test(ev.organisers)) return true;
  if (ev.airports.some((icao) => /^RJ[A-Z]{2}$/i.test(icao))) return true;
  if (/vatjpn|japan|日本/i.test(ev.name)) return true;
  return false;
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(FEED_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "AeroSocial/1.0 (+https://aerosocial.netaofficial.net)",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`VATSIM events feed: HTTP ${res.status}`);
    const payload = await res.json();
    const list = Array.isArray(payload) ? payload : payload?.data || [];
    const now = Date.now();
    const events = list
      .map(normalizeEvent)
      .filter((ev) => ev.startTime && !Number.isNaN(Date.parse(ev.startTime)))
      .filter((ev) => Date.parse(ev.endTime || ev.startTime) >= now)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    cache = { at: Date.now(), events };
    return events;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// 起動時に先読みし、以降は自動更新する。
refresh().catch((err) => console.error("[vatsim-events] initial fetch failed:", err.message));
const timer = setInterval(() => {
  refresh().catch((err) => console.error("[vatsim-events] refresh failed:", err.message));
}, REFRESH_MS);
timer.unref();

// GET /api/vatsim/events?scope=all|vatjpn
router.get("/events", async (req, res) => {
  // キャッシュが空 (起動直後の初回取得失敗など) のときだけ同期取得を試す。
  if (!cache.events.length && !cache.at) {
    try {
      await refresh();
    } catch (_) {
      /* 失敗時は空で返す。次回リクエストで再試行される */
    }
  }
  const scope = req.query.scope === "vatjpn" ? "vatjpn" : "all";
  const events = scope === "vatjpn" ? cache.events.filter(isJapanEvent) : cache.events;
  res.json({
    events,
    scope,
    updatedAt: cache.at ? new Date(cache.at).toISOString() : null,
    source: FEED_URL,
  });
});

module.exports = router;
