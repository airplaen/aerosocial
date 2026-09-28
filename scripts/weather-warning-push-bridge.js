// scripts/weather-warning-push-bridge.js
//
// Standalone, always-running bridge: every WARNING_POLL_INTERVAL_MS,
// checks the 気象庁 warning/advisory headline for every 地域 that at
// least one user has selected (users.warning_area_code — see
// src/routes/weather.js's PUT /api/weather/warning-subscription), and
// sends a Web Push notification to that area's subscribed users when a
// new headline appears.
//
// Unlike scripts/eew-push-bridge.js, this reuses src/lib/push.js directly
// (rather than re-implementing VAPID setup) — eew-push-bridge.js's own
// comments flag key-mismatch as a real risk from duplicating that setup,
// so this bridge deliberately shares the same module the main server uses
// instead of repeating that mistake. src/lib/push.js only needs
// src/db.js (a plain better-sqlite3 wrapper), so it works fine from this
// separate process without pulling in the whole Express app.
//
// This process and the main API server (pm2 process "aerosocial-api")
// are separate Node processes, so they do NOT share ws.js's in-memory
// WebSocket client list — a currently-open browser tab can only learn
// about a new warning here via Web Push (same as EEW: see sw.js's "push"
// handler, which relays the payload to any open tab via postMessage so
// it shows the richer in-app bar instead of just the OS notification).
// The admin panel's test-broadcast button is different: that runs inside
// the main API server process, so it *can* also use ws.js's
// broadcastToUsers for an instant same-tab preview — see routes/admin.js.
//
// 実行方法（他のブリッジと同様、pm2/systemd 等で常駐):
//   npm run weather-warning-bridge

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../src/db");
const push = require("../src/lib/push");
const { fetchWarningSummary } = require("../src/lib/weatherWarnings");

const WARNING_POLL_INTERVAL_MS = Number(process.env.WEATHER_WARNING_POLL_INTERVAL_MS) || 5 * 60 * 1000;
const STATE_PATH = process.env.WEATHER_WARNING_BRIDGE_STATE_PATH
  || path.join(__dirname, "..", "data", "weather-warning-bridge-state.json");

if (!push.enabled) {
  console.error(
    "[weather-warning-bridge] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が設定されていないため、" +
      "push通知を送れません。.envを確認してください。終了します。"
  );
  process.exit(1);
}

// 地域ごとの直近の見出し(重複通知防止 + 再起動時の誤爆防止)を永続化する。
// scripts/fsa-to-aerosocial-bridge.js や eew-push-bridge.js と同じ
// 「JSONファイルに前回状態を保存する」パターン。
let lastHeadlinesByArea = {};
try {
  lastHeadlinesByArea = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
} catch {
  // 初回起動 or ファイルなし/壊れている — 空の状態から始める
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(lastHeadlinesByArea, null, 2));
  } catch (err) {
    console.error("[weather-warning-bridge] 状態の保存に失敗しました:", err.message);
  }
}

function headlinesKey(headlines) {
  return headlines && headlines.length ? JSON.stringify([...headlines].sort()) : "";
}

// 1地域ぶんチェックし、新しい見出しが出ていれば対象ユーザーにpushする。
// isTest=trueのときは状態を更新も比較もせず、必ず配信する(管理者パネルの
// テスト配信用 — 実データの重複防止ロジックに影響を与えないようにする)。
async function checkArea(areaCode, userIds, { isTest = false } = {}) {
  const summary = await fetchWarningSummary(areaCode);
  if (summary.fetchError) {
    console.warn(`[weather-warning-bridge] ${areaCode} の取得に失敗しました:`, summary.fetchErrorMessage);
    return;
  }

  const key = headlinesKey(summary.headlines);
  if (!isTest) {
    const prevKey = lastHeadlinesByArea[areaCode];
    lastHeadlinesByArea[areaCode] = key;
    saveState();
    // 初回(この地域を初めて見た)は基準点を記録するだけで配信しない —
    // ブリッジを起動しただけで、既に出ていた警報を今起きたことのように
    // 全員へ通知してしまう事故を避けるため(eew-push-bridgeのREST補完
    // ポーリングと同じ考え方)。
    if (prevKey === undefined) return;
    if (key === prevKey) return; // 変化なし
    if (!key) return; // 警報が無くなった側の変化は今回は通知対象外
  }
  if (!summary.headlines || !summary.headlines.length) return;

  const title = `⚠️ ${summary.areaName} 気象警報・注意報`;
  const body = summary.headlines.join("\n");
  await push.pushToUsers([...userIds], {
    type: "warning",
    title,
    body,
    tag: `weather-warning-${areaCode}`,
    url: "/",
    areaCode,
    areaName: summary.areaName,
    headlines: summary.headlines,
    isTest,
  });
  console.log(`[weather-warning-bridge] ${isTest ? "[テスト] " : ""}${summary.areaName} へ配信しました (${userIds.size}人)。`);
}

async function pollAllAreas() {
  try {
    const result = await pool.query("SELECT id, warning_area_code FROM users WHERE warning_area_code IS NOT NULL");
    const usersByArea = new Map();
    for (const row of result.rows) {
      if (!usersByArea.has(row.warning_area_code)) usersByArea.set(row.warning_area_code, new Set());
      usersByArea.get(row.warning_area_code).add(row.id);
    }
    for (const [areaCode, userIds] of usersByArea) {
      await checkArea(areaCode, userIds);
    }
  } catch (err) {
    console.error("[weather-warning-bridge] ポーリング中にエラーが発生しました:", err.message);
  }
}

console.log(`[weather-warning-bridge] 起動しました。${Math.round(WARNING_POLL_INTERVAL_MS / 1000)}秒間隔でチェックします。`);
pollAllAreas();
setInterval(pollAllAreas, WARNING_POLL_INTERVAL_MS);
