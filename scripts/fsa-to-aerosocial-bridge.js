/**
 * scripts/fsa-to-aerosocial-bridge.js
 * ---------------------------------------------------------------
 * FSA（Flight Stream Assistant）のライブストリームを監視し、AeroSocial側に
 * フライトカード投稿を自動で作成する常駐ブリッジ。
 *
 * v2での変更点:
 *   - 従来は .env の FSA_PILOT_ID / AEROSOCIAL_CALLSIGN / AEROSOCIAL_PASSWORD
 *     で「このVPSのオーナー1人分」だけを監視・投稿する作りだった。
 *     v2ではこのブリッジは特定のpilot_idを一切知らない。SSEに流れてくる
 *     全パイロットを見て、AeroSocial側で「自分のFSAパイロットIDはこれ」と
 *     設定画面から登録した人がいれば、その人のアカウントとしてAeroSocial
 *     サーバーが投稿を作成する（誰との紐付けかはサーバー側 = 
 *     routes/fsaBridgeSettings.js の /api/internal/fsa-flight-post が解決
 *     する。ブリッジは共有シークレット FSA_BRIDGE_SECRET で認証するだけ）。
 *
 * v3での変更点:
 *   - v2では `flight_started` を追跡開始のトリガーとしてのみ使い、実際の
 *     投稿は地上速度が離陸とみなせる水準を連続で満たしたとき（＝実際に
 *     飛び立った後）に行っていた。v3ではこれをやめ、FSAにパイロットが
 *     現れた時点（`flight_started`受信、または`snapshot`/`update`に
 *     初めて登場した時点＝機体が「湧いた」時点）で即座に投稿する。
 *   - 個別取得用に想定していた `GET /api/live/:pilot_id` は実際には
 *     存在せず（`{ live: [...] }` でラップされた別形状のレスポンスが返る）
 *     ため、公式にドキュメントされている `GET /api/live`（全パイロットの
 *     スナップショット）を叩いてpilot_idが一致する1件を取り出す方式に
 *     修正した。
 *
 * 全体の流れ:
 *
 *   MSFS2020/2024
 *     └─ SimConnect ─▶ FSAデスクトップアプリ
 *                         └─ FSAクラウドバックエンドへライブデータ送信
 *                              └─ SSE (GET /api/live/stream) で
 *                                 snapshot / update / flight_started / offline
 *                                 を配信
 *                                   └─ このスクリプトが全イベントを購読
 *                                      └─ パイロットが初めて現れた時点で
 *                                         GET /api/live から詳細取得
 *                                         └─ AeroSocialのflight投稿形式に変換
 *                                            └─ POST /api/internal/fsa-flight-post
 *                                               （AeroSocial。X-Bridge-Secretで認証。
 *                                                pilot_id→ユーザーの解決と実際の
 *                                                投稿作成はサーバー側が行う）
 *
 * 認証まわり:
 * - FSA側: 読むだけなので認証不要（resolve-fsa-pilot-id.js のコメント参照）。
 * - AeroSocial側: JWTログインは行わない。.env の FSA_BRIDGE_SECRET を
 *   `X-Bridge-Secret` ヘッダーに載せて /api/internal/fsa-flight-post を叩く
 *   だけ（AeroSocialサーバー側の .env にも同じ値を設定しておく必要がある）。
 *
 * 投稿タイミング（v3）:
 * - FSAにパイロットが現れた時点（`flight_started`受信、または`snapshot`/
 *   `update`に初めて登場した時点）で即座に投稿する。地上速度による離陸
 *   確認は行わない（過去にこれが原因でFSAアプリ起動直後に誤って投稿
 *   していた実績があるが、現在はユーザーの希望により「湧いたら投稿」の
 *   即時トリガーに変更している）。
 *
 * 重複投稿防止:
 * - FSAの生データにセッション開始時刻らしきキーがあればそれを「セッション
 *   キー」として使う。無い場合は出発地・到着地・コールサイン・機種という
 *   フライト中は変化しない値の組み合わせを使う（v3.1、旧: ブリッジ側で
 *   検出した時刻=Date.now()を使っていたが、これは呼ぶ度に値が変わってしまい、
 *   ブリッジの再起動やSSEの瞬断で "offline"→再検出が起きる度に同じフライ
 *   トを重複投稿する原因になっていた）。
 * - このセッションキーを data/fsa-bridge-state.json に pilot_id ごとに
 *   記録し、直前と同じセッションキーならスキップする。
 *
 * MSFSの「デベロッパーモード」について:
 * - MSFS本体のDEVELOPER MODEをONにすると、実績(ACHIEVEMENTS)の累積処理と
 *   フライトログの記録が止まる（SimConnectの生データ自体は止まらない）。
 *   そのため、このブリッジは特定のフィールドが揃っていることを前提に
 *   しない防御的な実装にしてあり（下の FIELD_CANDIDATES）、フィールドが
 *   一部欠けていても投稿自体はスキップせずに続行する。デベロッパーモード
 *   中と判定できた場合は、投稿本文にその旨の一言を添える。
 *
 * 使い方:
 *   npm run bridge
 *   （常時起動させたい場合は `pm2 start scripts/fsa-to-aerosocial-bridge.js
 *    --name fsa-bridge` を推奨）
 *
 * デバッグ:
 *   node scripts/fsa-to-aerosocial-bridge.js --debug
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------------ 設定
const FSA_BASE_URL = process.env.FSA_BASE_URL;

// AeroSocial自体のURL。同じVPS上で動かす前提なら、nginx等を経由せず直接
// ローカルのExpressプロセスを叩いたほうがネットワーク的に確実。
const AEROSOCIAL_BASE_URL = process.env.AEROSOCIAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const BRIDGE_SECRET = process.env.FSA_BRIDGE_SECRET;

const DEBUG = process.argv.includes("--debug");
const STATE_PATH = process.env.FSA_BRIDGE_STATE_PATH || path.join(__dirname, "..", "data", "fsa-bridge-state.json");

// デベロッパーモード中でもフィールド不足を理由に投稿を諦めないかどうか。
const ALLOW_PARTIAL_FLIGHTS = process.env.FSA_BRIDGE_ALLOW_PARTIAL !== "false";

// 投稿に最低限必要とみなすフィールド
const REQUIRED_FOR_POST = ["originIcao", "destIcao"];

// 「離陸した」とみなす地上速度のしきい値（ノット）と、誤検知防止のための
// 連続観測回数。環境ごとにチューニングできるよう.envで上書き可能にする。
// v3: 離陸検知は廃止し、機体がFSAに現れた時点(flight_started/初回検出)で
// 即座に投稿する方式に変更したため、以下の閾値は使用していない。
// この時間、対象パイロットから何のイベントも来なければ追跡を諦める
// （フライト中断・SSE取りこぼし対策。メモリリーク防止も兼ねる）
const TRACKING_STALE_MS = Number(process.env.FSA_BRIDGE_STALE_MS || 30 * 60 * 1000);

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;

function fail(msg) {
  console.error(`[fsa-bridge] 設定エラー: ${msg}`);
  process.exit(1);
}
if (!FSA_BASE_URL) fail("FSA_BASE_URL が .env にありません。");
if (!BRIDGE_SECRET) {
  fail(
    "FSA_BRIDGE_SECRET が .env にありません（AeroSocialサーバー側の.envに設定した値と" +
      "同じものをこちらにも設定してください。ランダムな文字列で構いません）。"
  );
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function debugLog(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}] [debug]`, ...args);
}

// -------------------------------------------------------- 永続化（重複防止）
// pilot_id -> 最後に投稿したセッションキー。
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
let postedSessions = loadState(); // { [pilotId]: lastSessionKey }

// ------------------------------------------------------------ 汎用ヘルパー
// obj / obj.flight / obj.data / obj.live / obj.simbrief など、実データが
// どの階層に入っているか分からない場合に備えて、候補となるルートを複数試す。
// simbrief: 実際のFSAライブAPIでは dep/arr/cs/ac 等の基本フィールドは
// トップレベルに、便名・燃料・重量など詳細な計画値は "simbrief" オブジェクト
// 配下にネストされていることが確認できたため追加（--debug の生データより）。
function candidateRoots(obj) {
  if (!obj || typeof obj !== "object") return [obj];
  return [obj, obj.simbrief, obj.flight, obj.data, obj.live, obj.status].filter(
    (x) => x && typeof x === "object"
  );
}

function pick(obj, keys) {
  for (const root of candidateRoots(obj)) {
    for (const key of keys) {
      const v = root[key];
      // オブジェクトや配列を許してしまうと、waypoints配列がそのまま
      // route/etaのような「単一の値」を期待するフィールドに入り込み、
      // 画面側で "[object Object]" の羅列やInvalid Dateとして表示される
      // 原因になる（実際に発生した不具合）。ここではプリミティブ値
      // （文字列・数値・真偽値）だけを受け付け、object/arrayは無視して
      // 次の候補ルート/キーを探し続ける。
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object") continue;
      return v;
    }
  }
  return undefined;
}
function pickNumber(obj, keys) {
  const v = pick(obj, keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function pickBool(obj, keys) {
  const v = pick(obj, keys);
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "on", "yes"].includes(v.toLowerCase());
  return !!v;
}
// route文字列のように「人が読めるテキスト」を期待するフィールド専用。
// FSAの生データには同名 "route" キーが階層によって
// 配列（経由点のリスト。WAYPOINTS_CANDIDATES参照）だったり文字列
// （simbrief.route の便名経路文字列）だったりするため、配列/オブジェクトは
// 無視して文字列だけを拾う。これをやらないと配列がそのままflightに入り、
// 投稿時に "[object Object]" の羅列として表示されてしまう。
function pickString(obj, keys) {
  for (const root of candidateRoots(obj)) {
    for (const key of keys) {
      const v = root[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return undefined;
}

// FSAの生ライブデータ → AeroSocialのflight投稿フィールドの対応表。
// "dep"/"arr"/"cs"/"ac" は実際のFSAライブAPIで確認できたトップレベルの
// キー名（--debug の生データより。当初 dep_icao/callsign/aircraft_icao 等の
// 一般的な綴りしか候補に入れていなかったため、これらの値が一切拾えず
// 出発地・到着地が "?" になっていた）。
const FIELD_CANDIDATES = {
  originIcao: ["dep", "origin_icao", "originIcao", "dep_icao", "depIcao", "departure_icao"],
  originName: ["origin_name", "originName", "dep_name", "departure_name"],
  originLat: ["origin_lat", "originLat", "dep_lat"],
  originLon: ["origin_lon", "originLon", "dep_lon", "origin_lng", "originLng"],

  destIcao: ["arr", "dest_icao", "destIcao", "arr_icao", "arrIcao", "arrival_icao"],
  destName: ["dest_name", "destName", "arr_name", "arrival_name"],
  destLat: ["dest_lat", "destLat", "arr_lat"],
  destLon: ["dest_lon", "destLon", "arr_lon", "dest_lng", "destLng"],

  altIcao: ["alt_icao", "altIcao", "alternate_icao"],
  altName: ["alt_name", "altName", "alternate_name"],
  altLat: ["alt_lat", "altLat"],
  altLon: ["alt_lon", "altLon"],

  aircraftIcao: ["ac", "aircraft_icao", "aircraftIcao", "icao_type", "icaoType"],
  aircraftName: ["aircraft_name", "aircraftName", "aircraft_title", "title", "aircraft"],
  callsign: ["cs", "callsign", "atc_callsign", "flight_number", "flightNumber"],

  // cruiseAlt はFL380のような文字列で来ることがあるため数値変換の対象から
  // 外している（下のisNumeric一覧を参照）。
  cruiseAlt: ["cruise_altitude", "cruiseAlt", "cruise_alt"],
  distance: ["distance_nm", "distance", "route_distance", "dist_total"],
  paxCount: ["pax_count", "paxCount", "passengers"],

  blockFuel: ["block_fuel", "blockFuel"],
  tripFuel: ["trip_fuel", "tripFuel", "enroute_burn"],
  taxiFuel: ["taxi_fuel", "taxiFuel"],
  reserveFuel: ["reserve_fuel", "reserveFuel"],
  altFuel: ["alt_fuel", "altFuel"],
  estZfw: ["est_zfw", "estZfw"],
  estTow: ["est_tow", "estTow"],
  estLdw: ["est_ldw", "estLdw"],
  fuelUnit: ["fuel_unit", "fuelUnit", "units_fuel", "units"],
};
// route（人が読める経路文字列）専用の候補。上のFIELD_CANDIDATESとは別扱い
// にしているのは、トップレベルの "route" キーは文字列ではなく経由点の配列
// であり、pick()で拾うと配列がそのまま入ってしまうため（pickStringを使う）。
const ROUTE_TEXT_CANDIDATES = ["route", "route_raw", "navlog_route", "filed_route"];

// (v3で離陸検知を廃止したため、地上速度候補キーの定数は削除)

// セッションを一意に識別できそうなキー（重複投稿防止に使う）
const SESSION_KEY_CANDIDATES = ["start_ts", "started_at", "session_start", "start_time", "session_id"];
// MSFS「デベロッパーモード」中かどうかを示していそうなキー
const DEV_MODE_CANDIDATES = ["dev_mode", "developer_mode", "is_dev", "test_mode", "simulated"];
// ナブログ（経由点）のキー。"route" を追加: 実際のFSAライブAPIでは
// トップレベルの "route" が [{ident, lat, lon}, ...] という経由点の配列
// そのものだった（--debug の生データより）。これが候補に無かったため
// waypointsが常に空になっていた。
const WAYPOINTS_CANDIDATES = ["route", "waypoints", "navlog", "route_waypoints"];
const WAYPOINT_FIELD_CANDIDATES = {
  ident: ["ident", "name", "waypoint"],
  lat: ["lat", "latitude"],
  lon: ["lon", "lng", "longitude"],
  altitude: ["altitude", "alt"],
};

function extractWaypoints(liveData) {
  let raw;
  for (const root of candidateRoots(liveData)) {
    for (const key of WAYPOINTS_CANDIDATES) {
      if (Array.isArray(root[key])) {
        raw = root[key];
        break;
      }
    }
    if (raw) break;
  }
  if (!raw) return [];
  return raw
    .map((wp) => ({
      ident: pick(wp, WAYPOINT_FIELD_CANDIDATES.ident),
      lat: pickNumber(wp, WAYPOINT_FIELD_CANDIDATES.lat),
      lon: pickNumber(wp, WAYPOINT_FIELD_CANDIDATES.lon),
      altitude: pickNumber(wp, WAYPOINT_FIELD_CANDIDATES.altitude),
    }))
    .filter((wp) => wp.lat != null && wp.lon != null);
}

// cruise_alt が "FL350" のような文字列で来た場合にft単位の数値へ変換する。
// 素の数値（feet）で来た場合はそのまま数値化するだけ。
function parseCruiseAltFeet(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  const flMatch = s.match(/^FL\s*(\d+)$/i);
  if (flMatch) return Number(flMatch[1]) * 100;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// "1:07" のような "H:MM" 表記の所要時間文字列を分に変換する
// （simbrief.air_time / simbrief.ete がこの形式で来る）。
function parseHmsToMinutes(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

// eta は "07:27z" のような時刻だけの文字列で来ることがあり、Dateとして
// パースできない（Invalid Dateの原因）。一方 eta_epoch はUnix秒での
// 到着予定時刻で、あいまいさがないためこちらを優先的に使う。
function resolveEtaIso(liveData) {
  const epoch = pickNumber(liveData, ["eta_epoch", "eta_unix", "arrival_epoch"]);
  if (epoch !== undefined) return new Date(epoch * 1000).toISOString();
  const raw = pick(liveData, ["eta", "estimated_arrival", "eta_utc"]);
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function buildFlightPayload(liveData) {
  const flight = {};
  for (const [outKey, candidates] of Object.entries(FIELD_CANDIDATES)) {
    const isNumeric = [
      "originLat", "originLon", "destLat", "destLon", "altLat", "altLon",
      "distance", "durMin", "paxCount",
      "blockFuel", "tripFuel", "taxiFuel", "reserveFuel", "altFuel",
      "estZfw", "estTow", "estLdw",
    ].includes(outKey); // cruiseAlt除外: FSAは "FL380" のような文字列で送ってくるため
    const value = isNumeric ? pickNumber(liveData, candidates) : pick(liveData, candidates);
    if (value !== undefined) flight[outKey] = value;
  }
  // route（経路の文字列表現）は配列と同じキー名で衝突するため専用の
  // pickStringで取得する（上のFIELD_CANDIDATESループでは扱わない）。
  const routeText = pickString(liveData, ROUTE_TEXT_CANDIDATES);
  if (routeText !== undefined) flight.route = routeText;

  // cruiseAlt: "FL350" のような文字列で来た場合はft数値に変換する。
  if (flight.cruiseAlt !== undefined) {
    const feet = parseCruiseAltFeet(flight.cruiseAlt);
    if (feet !== undefined) flight.cruiseAlt = feet;
    else delete flight.cruiseAlt; // 変換できない値は表示側の "FLNaN" を防ぐため捨てる
  }

  // durMin: 分の数値フィールドが無ければ、simbriefの "1:07" のような
  // H:MM表記（air_time優先、無ければete）から分単位に変換する。
  const durMinDirect = pickNumber(liveData, ["duration_min", "durMin", "est_time_enroute_min", "flight_time_min"]);
  if (durMinDirect !== undefined) {
    flight.durMin = durMinDirect;
  } else {
    const hms = pickString(liveData, ["air_time", "ete", "block_time"]);
    const parsed = parseHmsToMinutes(hms);
    if (parsed !== undefined) flight.durMin = parsed;
  }

  // eta: "07:27z" のような時刻だけの文字列はDateとしてパースできないため、
  // eta_epoch（Unix秒）があればそちらを優先してISO文字列に変換する。
  const etaIso = resolveEtaIso(liveData);
  if (etaIso !== undefined) flight.eta = etaIso;

  flight.type = "flight";
  const waypoints = extractWaypoints(liveData);
  if (waypoints.length) flight.waypoints = waypoints;

  // originLat/Lon・destLat/Lonが無ければ、route配列の最初/最後の地点
  // （出発/到着空港そのもの）の座標で補完する。これが無いと地図表示
  // （initFullscreenMap等）がスキップされてしまう。
  if (waypoints.length) {
    const first = waypoints[0];
    const last = waypoints[waypoints.length - 1];
    if (flight.originLat === undefined && first) { flight.originLat = first.lat; flight.originLon = first.lon; }
    if (flight.destLat === undefined && last) { flight.destLat = last.lat; flight.destLon = last.lon; }
  }

  return flight;
}

function missingRequiredFields(flight) {
  return REQUIRED_FOR_POST.filter((k) => flight[k] === undefined || flight[k] === null || flight[k] === "");
}

function sessionKeyFor(liveData) {
  const v = pick(liveData, SESSION_KEY_CANDIDATES);
  if (v !== undefined) return String(v);

  // SESSION_KEY_CANDIDATES がどれもヒットしない場合のフォールバック。
  // 以前はここで `t:${Date.now()}` を都度生成していたが、これは
  // 「呼ばれる度に必ず違う値」になってしまい、実質的にセッションキーとして
  // 機能していなかった。具体的には:
  //   - ブリッジの再起動（pm2再起動・デプロイ・クラッシュ復帰）
  //   - SSEの瞬断で "offline" イベントが来て clearTracking() された後、
  //     同じフライトのまま "snapshot"/"update" が再度来て追跡し直す場合
  // のどちらでも、まだ飛行中の同一フライトに対して新しい
  // fallbackキーが生成され、data/fsa-bridge-state.json に保存済みの
  // 前回のキーと一致しなくなるため、重複投稿が起きていた。
  //
  // 代わりに、出発地・到着地・コールサイン・機種というフライト開始時に
  // 決まり、通常は同一フライト中に変化しない値を組み合わせて使う。
  // これなら再起動やSSEの瞬断を挟んでも同じキーになり、既存の
  // 「直前と同じセッションキーならスキップ」ロジックが正しく働く。
  // トレードオフ: 同じパイロットが同一区間・同一機種で連続して2回
  // フライトした場合はごく稀に取りこぼす可能性があるが、重複投稿の方が
  // 実害が大きいためこちらを優先する。
  const stableParts = [
    pick(liveData, FIELD_CANDIDATES.originIcao),
    pick(liveData, FIELD_CANDIDATES.destIcao),
    pick(liveData, FIELD_CANDIDATES.callsign),
    pick(liveData, FIELD_CANDIDATES.aircraftIcao),
  ].map((p) => (p === undefined || p === null ? "" : String(p)));

  if (stableParts.some((p) => p !== "")) {
    return `flight:${stableParts.join("|")}`;
  }

  // 出発地・到着地・コールサイン・機種のいずれも取得できない場合のみ、
  // 最終手段としてタイムスタンプを使う（この場合は元々セッションの
  // 一意性を判定する材料がないため、重複防止は保証できない）。
  return `t:${Date.now()}`;
}

// ------------------------------------------------------------ FSA側クライアント
// GET /api/live/:pilot_id という個別取得エンドポイントは message.txt
// （FSAの公式API一覧）に存在せず、実際に叩いてみると `{ live: [...] }` という
// 配列でラップされたレスポンスが返ってきていた（＝ /api/live と同じ形）。
// candidateRoots()はこの配列そのものを1つのルートとして扱ってしまい、
// 配列に "dep"/"arr" のようなプロパティは存在しないため、全フィールドの
// 取得が常に失敗して出発地・到着地が "????" になっていた。
// 正しくは message.txt にも明記されている /api/live（全パイロットのスナップ
// ショット、{ live: [...] }）を叩き、その中から対象のpilot_idの要素を
// 1件だけ取り出して使う。
async function fetchFsaLiveDetail(pilotId) {
  const url = new URL("/api/live", FSA_BASE_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FSA /api/live が失敗しました: HTTP ${res.status}`);
  const data = await res.json();
  const list = data && Array.isArray(data.live) ? data.live : [];
  const entry = list.find((item) => String(pick(item, ["pilot_id", "pilotId"])) === String(pilotId));
  if (!entry) throw new Error(`FSA /api/live のスナップショットに pilot_id=${pilotId} が見つかりませんでした。`);
  debugLog("FSA live detail:", JSON.stringify(entry));
  return entry;
}

// GET /api/live/stream をSSEとして手動パースする。
async function consumeLiveStream(onEvent, signal) {
  const url = new URL("/api/live/stream", FSA_BASE_URL);
  const res = await fetch(url, { signal, headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`FSA /api/live/stream への接続に失敗しました: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flush = () => {
    if (dataLines.length) {
      const raw = dataLines.join("\n");
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      onEvent(eventName, data);
    }
    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);

      if (line === "") { flush(); continue; }
      if (line.startsWith(":")) continue; // ハートビート（`: ping`）は無視
      if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
    }
  }
}

// ---------------------------------------------------------- AeroSocial側クライアント
// pilot_id→ユーザーの解決とpost作成そのものはAeroSocialサーバー側
// （routes/fsaBridgeSettings.js）が行う。ブリッジは共有シークレットだけで
// 認証し、結果として「投稿されたかどうか・されなかった理由」を受け取る。
async function postFlightCard(pilotId, flight, caption) {
  const res = await fetch(new URL("/api/internal/fsa-flight-post", AEROSOCIAL_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": BRIDGE_SECRET },
    body: JSON.stringify({ pilotId, flight, caption }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`AeroSocialへの投稿に失敗しました: ${(data && data.error) || res.status}`);
  return data; // { posted: boolean, reason?: string, postId?: string }
}

// -------------------------------------------------------------- 投稿トリガー管理
// pilot_id -> { posted, lastSeenTs }
// v3変更: 離陸（地上速度しきい値）を待たず、FSAにパイロットが現れた時点
// （flight_started受信、またはsnapshot/updateに初めて登場した時点）で
// 即座に投稿する。同一セッション内での重複投稿はpostedフラグと
// postedSessions（セッションキー）の二重チェックで防ぐ。
const tracking = new Map();

function noteSeen(pilotId) {
  const entry = tracking.get(pilotId) || { posted: false, lastSeenTs: Date.now() };
  entry.lastSeenTs = Date.now();
  tracking.set(pilotId, entry);
  return entry;
}

function clearTracking(pilotId) {
  tracking.delete(pilotId);
}

// 追跡していない古いエントリを定期的に掃除（メモリリーク防止）
setInterval(() => {
  const now = Date.now();
  for (const [pilotId, entry] of tracking) {
    if (now - entry.lastSeenTs > TRACKING_STALE_MS) tracking.delete(pilotId);
  }
}, 60000).unref();

async function maybePostForPilot(pilotId, entry) {
  if (entry.posted) return; // このプロセス内での二重トリガー防止

  entry.posted = true; // 詳細取得〜投稿の間に来る後続イベントで再トリガーしない

  try {
    const liveData = await fetchFsaLiveDetail(pilotId);
    // sessionKeyFor は常に文字列を返す（フォールバックの生成も内部で行う）
    const sessionKey = sessionKeyFor(liveData);

    if (postedSessions[pilotId] === sessionKey) {
      debugLog(`pilot_id=${pilotId}: 同じセッションを既に投稿済みなのでスキップします。`);
      return;
    }

    const flight = buildFlightPayload(liveData);
    const devMode = !!pickBool(liveData, DEV_MODE_CANDIDATES);
    const missing = missingRequiredFields(flight);
    if (missing.length && !ALLOW_PARTIAL_FLIGHTS) {
      log(`pilot_id=${pilotId}: 必須フィールドが不足しているため投稿をスキップしました: ${missing.join(", ")}`);
      return;
    }
    if (missing.length) {
      log(`pilot_id=${pilotId}: 一部フィールドが不足していますが投稿します（不足: ${missing.join(", ")}）。`);
    }

    let caption = `🛫 ${flight.originIcao || "?"} → ${flight.destIcao || "?"} のフライトを開始しました`;
    if (flight.aircraftName) caption += `（${flight.aircraftName}）`;
    if (devMode) caption += "\n※MSFSのデベロッパーモード中に記録されたテスト飛行です。";

    const result = await postFlightCard(pilotId, flight, caption);
    if (result.posted) {
      log(`pilot_id=${pilotId}: 投稿しました（post id=${result.postId}）。`);
      postedSessions[pilotId] = sessionKey;
      saveState(postedSessions);
    } else {
      debugLog(`pilot_id=${pilotId}: 投稿されませんでした（reason=${result.reason}）。`);
    }
  } catch (err) {
    log(`pilot_id=${pilotId}: 投稿処理中にエラーが発生しました: ${err.message}`);
    entry.posted = false; // エラー時は次のイベントでリトライできるようにする
  }
}

// -------------------------------------------------------------- イベント処理
function handleLiveEvent(eventName, data) {
  debugLog("SSEイベント:", eventName, JSON.stringify(data));

  if (eventName === "snapshot") {
    const list = data && Array.isArray(data.live) ? data.live : [];
    for (const item of list) {
      const pilotId = pick(item, ["pilot_id", "pilotId"]);
      if (pilotId === undefined) continue;
      const entry = noteSeen(String(pilotId));
      maybePostForPilot(String(pilotId), entry);
    }
    return;
  }

  if (eventName === "update") {
    const pilotId = pick(data, ["pilot_id", "pilotId"]);
    if (pilotId === undefined) return;
    const entry = noteSeen(String(pilotId));
    maybePostForPilot(String(pilotId), entry);
    return;
  }

  if (eventName === "flight_started") {
    // 機体がFSAに現れた（湧いた）ことの通知。以前は誤検知防止のため
    // ここでは投稿せず離陸確認を待っていたが、現在は即座に投稿する。
    const pilotId = pick(data, ["pilot_id", "pilotId"]) ?? data;
    if (pilotId === undefined || pilotId === null) return;
    const entry = noteSeen(String(pilotId));
    debugLog(`pilot_id=${pilotId}: flight_started を受信、投稿します。`);
    maybePostForPilot(String(pilotId), entry);
    return;
  }

  if (eventName === "offline") {
    const pilotId = pick(data, ["pilot_id", "pilotId"]);
    if (pilotId !== undefined) clearTracking(String(pilotId));
    return;
  }
}


async function runForever() {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const onSigterm = () => controller.abort();
    process.once("SIGINT", onSigterm);
    process.once("SIGTERM", onSigterm);

    try {
      log(`FSAのライブストリームに接続します: ${new URL("/api/live/stream", FSA_BASE_URL)}`);
      attempt = 0; // 接続できたのでバックオフをリセット
      await consumeLiveStream(handleLiveEvent, controller.signal);
      log("FSAのライブストリームが切断されました。再接続します。");
    } catch (err) {
      if (controller.signal.aborted) {
        log("終了シグナルを受け取りました。");
        return;
      }
      log("FSAのライブストリームでエラーが発生しました:", err.message);
    } finally {
      process.removeListener("SIGINT", onSigterm);
      process.removeListener("SIGTERM", onSigterm);
    }

    if (controller.signal.aborted) return;
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt += 1;
    log(`${Math.round(wait / 1000)}秒後に再接続します。`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function main() {
  log("fsa-to-aerosocial-bridge を起動しました（複数パイロット対応・離陸確認方式）。");
  log(`FSA: ${FSA_BASE_URL} / AeroSocial: ${AEROSOCIAL_BASE_URL}`);
  log("投稿タイミング: FSAに機体が現れた時点（flight_started/初回検出）で即座に投稿");
  await runForever();
  log("終了しました。");
}

main().catch((err) => {
  console.error("[fsa-bridge] 致命的エラー:", err);
  process.exit(1);
});
