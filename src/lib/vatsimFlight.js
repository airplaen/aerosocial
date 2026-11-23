/**
 * src/lib/vatsimFlight.js
 * ---------------------------------------------------------------
 * VATSIM のライブデータフィード（https://data.vatsim.net/v3/vatsim-data.json）
 * の pilots[] の1要素（接続中のパイロット）から、AeroSocial の
 * `flight` 投稿オブジェクトを組み立てる純粋関数群。
 *
 * FSA 自動投稿（scripts/fsa-to-aerosocial-bridge.js → routes/fsaFlightPost.js）
 * と同じ `flight` の形（type:"flight", originIcao, destIcao, callsign,
 * aircraftIcao, cruiseAlt(ft), route(文字列), durMin, eta(ISO) ...）に揃えてあるので、
 * 投稿カード（public/app.js の flightCardHtml）はそのまま同じ見た目で表示される。
 *
 * VATSIM のフライトプラン由来の値とその扱い:
 *   - departure / arrival / alternate : ICAO。そのまま使う
 *   - aircraft_short                  : 機種のICAO（例 A320）。無ければ aircraft の "H/A320/L" から抽出
 *   - altitude                        : "FL350" / "F350" / "35000" のいずれも feet に変換
 *   - route                           : 経路の文字列（そのまま）
 *   - enroute_time                    : "0342"（3時間42分）→ durMin
 *   - deptime (Zulu HHMM)             : 出発時刻。enroute_time と合わせて eta を算出
 *   - 距離                            : フィードには無いので、出発・到着空港の
 *                                       座標から大圏距離を算出する
 *                                       (lib/airportDistance.js)。空港がデータに
 *                                       無い場合だけ含めない
 *   - 経由点の座標                    : フィードには無いので含めない
 *                                       （FSA カードの地図は表示されない）
 *
 * セッションキー（二重投稿防止に使う）:
 *   callsign + 出発 + 到着 + ログオン日（UTC）の組み合わせ。
 *   同じ日に再接続しても同じキーになるので、切断→再接続で重複投稿しない。
 */

"use strict";

// 距離の算出は補助機能なので、データ/モジュールが読めない環境でも
// 投稿そのものは止めない (その場合は distance を付けない)。
let distanceNmBetween = () => null;
try {
  ({ distanceNmBetween } = require("./airportDistance"));
} catch {
  /* distance omitted */
}

const MS_PER_MIN = 60 * 1000;
const HALF_DAY_MS = 12 * 60 * MS_PER_MIN;

function strOf(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

// "0342" → 222（分）。enroute_time 用なので時間は2桁以上でも可（"0342", "342", "03:42"）。
function parseDurationMinutes(raw) {
  const s = strOf(raw);
  const m = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return undefined;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 ? mins : undefined;
}

// deptime は UTC の時刻（"0955" → 1日の中の分数 575）。
function parseZuluClockMinutes(raw) {
  const s = strOf(raw);
  const m = s.match(/^(\d{2}):?(\d{2})$/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return undefined;
  return h * 60 + mi;
}

// "FL350" / "F350" → 35000ft。"35000" → 35000ft。
// 1000未満の素の数値（"350"）は FL とみなす。変換できない値は undefined。
function parseCruiseAltFeet(raw) {
  const s = strOf(raw).toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^(FL|F)?(\d{2,5})$/);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (m[1] || n < 1000) return n * 100;
  return n;
}

// "H/A320/L" → "A320"。単純な "A320" はそのまま。
function parseAircraftIcao(aircraftShort, aircraft) {
  const direct = strOf(aircraftShort).toUpperCase();
  if (direct) return direct;
  const parts = strOf(aircraft).toUpperCase().split("/");
  if (parts.length >= 2 && parts[1]) return parts[1];
  return parts[0] || "";
}

// ログオン時刻から UTC の日付（YYYY-MM-DD）を取る。解析できなければ now の日付。
function logonDateUtc(logonTime, now) {
  const s = strOf(logonTime);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return now.toISOString().slice(0, 10);
}

// deptime（Zulu の時刻のみ）を、now に最も近い UTC の日付に置いたときの epoch ms。
function departureEpochNear(depMinutesOfDay, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let dep = today + depMinutesOfDay * MS_PER_MIN;
  const nowMs = now.getTime();
  if (dep - nowMs > HALF_DAY_MS) dep -= 24 * 60 * MS_PER_MIN;
  else if (nowMs - dep > HALF_DAY_MS) dep += 24 * 60 * MS_PER_MIN;
  return dep;
}

/**
 * VATSIM の pilot オブジェクトから flight 投稿用オブジェクトを作る。
 * フライトプランが無い、または出発地・到着地が空の場合は null を返す
 * （＝まだ投稿できる状態ではない）。
 */
function buildFlightFromVatsim(pilot, now = new Date()) {
  const fp = pilot && typeof pilot.flight_plan === "object" ? pilot.flight_plan : null;
  if (!fp) return null;

  const dep = strOf(fp.departure).toUpperCase();
  const arr = strOf(fp.arrival).toUpperCase();
  if (!dep || !arr) return null;

  const flight = { type: "flight", originIcao: dep, destIcao: arr };

  // VATSIM フィードに距離は無いので、空港座標から大圏距離を算出する。
  // これが無いとログブック/ランキングの合計飛行距離に算入されない。
  const distance = distanceNmBetween(dep, arr);
  if (distance != null) flight.distance = distance;

  const alt = strOf(fp.alternate).toUpperCase();
  if (alt) flight.altIcao = alt;

  const callsign = strOf(pilot.callsign).toUpperCase();
  if (callsign) flight.callsign = callsign;

  const ac = parseAircraftIcao(fp.aircraft_short, fp.aircraft);
  if (ac) flight.aircraftIcao = ac;

  const cruiseAlt = parseCruiseAltFeet(fp.altitude);
  if (cruiseAlt !== undefined) flight.cruiseAlt = cruiseAlt;

  const route = strOf(fp.route);
  if (route) flight.route = route;

  const dur = parseDurationMinutes(fp.enroute_time);
  if (dur !== undefined) {
    flight.durMin = dur;
    const depMin = parseZuluClockMinutes(fp.deptime);
    if (depMin !== undefined) {
      const depMs = departureEpochNear(depMin, now);
      flight.eta = new Date(depMs + dur * MS_PER_MIN).toISOString();
    }
  }

  return flight;
}

// 二重投稿防止用のセッションキー（pilot_id とは別に、サーバー側の
// fsa_posted_sessions.session_key として保存する）。
function sessionKeyFor(pilot, flight, now = new Date()) {
  const date = logonDateUtc(pilot.logon_time, now);
  return [flight.callsign || "", flight.originIcao, flight.destIcao, date].join("|");
}

// FSA のカードと同じ文言。
function captionFor(flight) {
  let caption = `🛫 ${flight.originIcao || "?"} → ${flight.destIcao || "?"} のフライトを開始しました`;
  if (flight.aircraftName) caption += `（${flight.aircraftName}）`;
  else if (flight.aircraftIcao) caption += `（${flight.aircraftIcao}）`;
  return caption;
}

module.exports = {
  buildFlightFromVatsim,
  sessionKeyFor,
  captionFor,
  // テスト・ブリッジ用に個別の変換関数も公開する
  parseDurationMinutes,
  parseZuluClockMinutes,
  parseCruiseAltFeet,
  parseAircraftIcao,
};
