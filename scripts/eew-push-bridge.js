// scripts/eew-push-bridge.js
//
// Standalone, always-running bridge: connects to P2P地震情報(P2PQuake)の
// 本番WebSocketフィードを購読し、緊急地震速報（EEW, コード556。加えて、
// 556よりわずかに早く届く「発表検出」シグナルのコード554も軽い一報として）
// を受信すると、push_subscriptions に登録されている全ブラウザへWeb Push
// 通知として配信する。
//
// なぜこれが要るか: アプリ内ポップアップ（app.js の connectQuakeWS /
// showEewPopup）は、あくまでアプリのJSが実際にタブの中で動いている間しか
// 機能しない。スマホの画面ロック中やアプリがバックグラウンド/終了状態に
// あるとき、モバイルOSはそのJSの実行を止めてしまうことが多く、そうなると
// クライアント側の対策（再接続ウォッチドッグやREST補完ポーリング）も
// 無力になる。Push通知はOSが配信するため、アプリが閉じていても
// Service Workerが起こされて届く——ここがその抜け穴を塞ぐ層になる。
//
// 各ユーザーの postNotify（"all"|"following"）設定は投稿通知専用の設定
// なので、ここでは意図的に無視する。EEWは push_subscriptions に有効な
// 購読があるブラウザ全員に配信する（オプトアウトはあえて用意していない）。
//
// ⚠️ 要確認: このスクリプトはVAPID鍵を独自にenvから読んでいる
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)。もし
// lib/push.js が別の環境変数名を使っている、またはVAPID鍵ペア自体が
// 違う場合、ブラウザ側の購読（/api/notifications/subscribe で登録した
// もの）と鍵が一致せず、web-push 側は例外を投げずに401/403で静かに
// 失敗する。運用前に lib/push.js の中身を見せてもらい、鍵の出どころを
// 揃えるべき。
//
// 実行方法（fsa-to-aerosocial-bridge.js と同様、pm2/systemd 等で常駐):
//   npm run eew-bridge
//
// テスト配信を許可したい場合（P2PQuakeの訓練配信で誤って全ユーザーに
// 警報を出さないよう、既定では test:true のメッセージは無視する):
//   EEW_PUSH_ALLOW_TEST=1 npm run eew-bridge

require("dotenv").config();
const path = require("path");
const WebSocket = require("ws");
const webpush = require("web-push");
const Database = require("better-sqlite3");

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "aerosocial.db");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error(
    "[eew-bridge] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が設定されていません。" +
      "lib/push.js が使っているものと同じ値を .env に設定してください。終了します。"
  );
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const ALLOW_TEST = process.env.EEW_PUSH_ALLOW_TEST === "1";

const QUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";
let ws = null;
let retryTimer = null;

// app.js の SCALE_LABELS / eewMaxScaleFromAreas と同じロジック。フロントと
// このスクリプトはモジュールを共有していないため、手動で同期している —
// 片方だけ変更した場合はもう片方も直すこと。
const SCALE_LABELS = { "-1": "不明", 10: "1", 20: "2", 30: "3", 40: "4", 45: "5弱", 50: "5強", 55: "6弱", 60: "6強", 70: "7", 99: "7以上" };
function scaleLabel(scale) {
  if (scale == null) return "不明";
  return SCALE_LABELS[scale] ?? String(scale);
}

function maxScaleFromAreas(areas) {
  if (!Array.isArray(areas) || !areas.length) return null;
  let max = null;
  for (const a of areas) {
    const raw = a && (a.scaleTo != null ? a.scaleTo : a.scaleFrom);
    const v = raw != null ? Number(raw) : null;
    if (v != null && Number.isFinite(v) && v !== -1 && (max === null || v > max)) max = v;
  }
  return max;
}

function connect() {
  if (ws) {
    ws.removeAllListeners();
    try { ws.close(); } catch { /* already closing/closed */ }
  }
  ws = new WebSocket(QUAKE_WS_URL);

  ws.on("open", () => {
    console.log("[eew-bridge] P2PQuake WSに接続しました。");
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  });
  ws.on("close", () => {
    console.warn("[eew-bridge] 接続が切れました。5秒後に再接続します。");
    retryTimer = setTimeout(connect, 5000);
  });
  ws.on("error", (err) => {
    console.error("[eew-bridge] WSエラー:", err && err.message);
    try { ws.close(); } catch { /* onclose above triggers the retry */ }
  });
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleMessage(msg);
  });
}

function handleMessage(msg) {
  if (!msg || typeof msg.code !== "number") return;
  const isTest = msg.test === true;
  if (isTest && !ALLOW_TEST) return;

  if (msg.code === 554) {
    // 緊急地震速報の発表検出 — 556より早く届く、詳細のないシグナル。
    // ここでも一報を出しておくと、後続の556が万一遅延・欠落しても
    // 最初の気づきだけは確保できる（フロント側のhandleQuakeMessageと
    // 同じ考え方）。
    broadcastPush(
      { type: "eew", isTest, detectionOnly: true },
      { title: "⚠️ 緊急地震速報を検知しました", body: "詳細情報を確認中です…" }
    );
  } else if (msg.code === 556) {
    if (msg.cancelled) {
      broadcastPush(
        { type: "eew", isTest, cancelled: true },
        { title: "緊急地震速報の取り消し", body: "先ほどの緊急地震速報は取り消されました。" }
      );
      return;
    }
    const eq = msg.earthquake || {};
    const h = eq.hypocenter || {};
    const maxScale = maxScaleFromAreas(msg.areas);
    const hypocenterName = h.name || null;
    const areaCount = Array.isArray(msg.areas) ? msg.areas.length : null;
    broadcastPush(
      { type: "eew", isTest, hypocenterName, maxScale, areaCount },
      { title: "⚠️ 緊急地震速報（予報）", body: `震源: ${hypocenterName || "不明"} / 予想最大震度: ${scaleLabel(maxScale)}` }
    );
  }
}

function broadcastPush(eewPayload, notif) {
  const db = new Database(dbPath, { readonly: true });
  let subs;
  try {
    subs = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions").all();
  } finally {
    db.close();
  }
  console.log(`[eew-bridge] ${subs.length}件の購読へ配信します（isTest=${eewPayload.isTest}）。`);
  if (!subs.length) return;

  // The payload shape here (type/isTest/cancelled/detectionOnly/
  // hypocenterName/maxScale/areaCount) intentionally mirrors the `eew`
  // object app.js's showEewPopup() already knows how to render — sw.js
  // forwards this same object verbatim to any open tab via
  // postMessage, so the app can show its richer in-app banner instead
  // of (or alongside) the bare OS notification. title/body/tag/url are
  // for the OS notification only; showEewPopup ignores them.
  const payload = JSON.stringify({
    title: notif.title,
    body: notif.body,
    tag: "eew",
    url: "/",
    ...eewPayload,
  });

  const toRemove = [];
  Promise.allSettled(
    subs.map((s) =>
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        .catch((err) => {
          // 404/410 = ブラウザ側で購読が解除済み/期限切れ。今後も送り続け
          // ないよう掃除する（routes/notifications.js の /unsubscribe と
          // 同じ考え方）。それ以外のエラー（VAPID鍵不一致の401/403含む）は
          // ログに出して調査できるようにする。
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            toRemove.push(s.id);
          } else {
            console.error(`[eew-bridge] 送信失敗 (subscription id=${s.id}):`, err && (err.statusCode || err.message));
          }
        })
    )
  ).then(() => {
    if (!toRemove.length) return;
    const cleanupDb = new Database(dbPath);
    try {
      const stmt = cleanupDb.prepare("DELETE FROM push_subscriptions WHERE id = ?");
      for (const id of toRemove) stmt.run(id);
      console.log(`[eew-bridge] 期限切れの購読を${toRemove.length}件削除しました。`);
    } finally {
      cleanupDb.close();
    }
  });
}

connect();
