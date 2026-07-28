/**
 * scripts/resolve-fsa-pilot-id.js
 * ---------------------------------------------------------------
 * FSAにGoogleアカウントで登録しているユーザー向けの、一回限り実行する
 * ヘルパースクリプト。
 *
 * fsa-to-aerosocial-bridge.js は常駐プロセスなので、ブラウザでの操作が
 * 必要なGoogle OAuthをそのプロセスの中で毎回やり直すのには向いていない。
 * 一方で、ブリッジが実際に使うFSAのAPI（GET /api/live/stream と
 * GET /api/live/:pilot_id）はどちらも認証不要（message.txtの表で
 * 「不要」と明記されている）。つまりブリッジ自身はFSAへのログインが
 * 一切不要で、"自分のpilot_idが何か" さえ分かればよい。
 *
 * このスクリプトはその pilot_id を一度だけ調べるための道具:
 *   1. FSA の /auth/google/start?session_id=... のURLを表示する
 *   2. そのURLをブラウザで開いてGoogleでログインしてもらう
 *   3. /auth/google/poll?session_id=... をポーリングしてログイン完了を検知
 *   4. 完了したら発行されたトークンで /auth/me を叩き、pilot_id を表示する
 *
 * 使い方:
 *   node scripts/resolve-fsa-pilot-id.js
 *   （反応がおかしい場合は node scripts/resolve-fsa-pilot-id.js --debug で
 *    各APIの生レスポンスを表示できる）
 *
 * 出てきた pilot_id は、AeroSocial側の設定画面（ホーム画面の設定 →
 * 「FSAパイロットID」欄、または /fsa-settings.html）に入力してください。
 * ブリッジ（fsa-to-aerosocial-bridge.js）はもう特定の1人分のpilot_idを
 * .envに書く方式ではなく、AeroSocial側に登録された全ユーザー分をまとめて
 * 見に行く作りになっているため、.envへの追記は不要です。
 *
 * ⚠️ 注意（要確認・要調整の箇所）:
 * /auth/google/poll のレスポンス形式（ログイン待ち中/完了時のフィールド名）
 * はドキュメントに明記されていない。このスクリプトは「token/jwt系のキーが
 * 出てくるまでは待ち中とみなす」という防御的な実装にしている。ポーリングが
 * 終わらない・失敗する場合は --debug を付けて実際のレスポンスを確認し、
 * 下の TOKEN_KEYS / PENDING_VALUES を実際のキー名・値に合わせること。
 */

"use strict";

require("dotenv").config();
const crypto = require("crypto");

const FSA_BASE_URL = process.env.FSA_BASE_URL;
if (!FSA_BASE_URL) {
  console.error("FSA_BASE_URL が .env に設定されていません（aerosocial-backend/.env に追記してください）。");
  process.exit(1);
}

const DEBUG = process.argv.includes("--debug");
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5分でタイムアウト

// ログイン完了時にトークンが入っていそうなキー名の候補（実際のレスポンスに合わせて調整）
const TOKEN_KEYS = ["token", "jwt", "access_token", "accessToken"];
// まだログイン待ちであることを示す status/state 値の候補
const PENDING_VALUES = ["pending", "waiting", "not_ready", "none"];

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

async function apiJson(pathAndQuery, { token } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(new URL(pathAndQuery, FSA_BASE_URL), { headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 空ボディ */
  }
  if (DEBUG) console.log(`[debug] GET ${pathAndQuery} -> HTTP ${res.status}`, JSON.stringify(data));
  return { status: res.status, data };
}

function isPending(data) {
  if (!data) return true;
  const status = pick(data, ["status", "state"]);
  if (status && PENDING_VALUES.includes(String(status).toLowerCase())) return true;
  return pick(data, TOKEN_KEYS) === undefined;
}

async function main() {
  const sessionId = crypto.randomUUID();
  const startUrl = new URL("/auth/google/start", FSA_BASE_URL);
  startUrl.searchParams.set("session_id", sessionId);

  console.log("以下のURLをブラウザで開き、FSAに登録しているGoogleアカウントでログインしてください:\n");
  console.log(String(startUrl));
  console.log("\nログイン完了を待っています…（最大5分。--debug で詳細ログ表示）");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data } = await apiJson(`/auth/google/poll?session_id=${encodeURIComponent(sessionId)}`);

    if (data && (data.error || String(pick(data, ["status"]) || "").toLowerCase() === "error")) {
      console.error("\nログインに失敗しました:", data.error || JSON.stringify(data));
      process.exit(1);
    }

    if (!isPending(data)) {
      const token = pick(data, TOKEN_KEYS);
      console.log("\nログインを検知しました。自分の情報を取得します…");

      const me = await apiJson("/auth/me", { token });
      const pilotId =
        pick(me.data, ["id", "pilot_id", "uid"]) ?? pick((me.data && me.data.user) || {}, ["id", "pilot_id", "uid"]);

      if (!pilotId) {
        console.error(
          "/auth/me の応答から pilot_id を特定できませんでした。--debug を付けて再実行し、応答内容を確認してください。"
        );
        process.exit(1);
      }

      console.log("\n✅ あなたの pilot_id:", pilotId);
      console.log("\n.env に以下を追記してください（FSA_EMAIL/FSA_PASSWORDは不要なので設定していなくてOK）:");
      console.log(`FSA_PILOT_ID=${pilotId}`);
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.error("\nタイムアウトしました。もう一度実行して、案内されたURLで速やかにログインしてください。");
  process.exit(1);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
