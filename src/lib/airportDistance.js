/**
 * src/lib/airportDistance.js
 * ---------------------------------------------------------------
 * 空港間の大圏距離 (nm) を ICAO コードから計算する。
 *
 * VATSIM のフィードには距離も空港の座標も含まれないため、VATSIM 由来の
 * フライト投稿には distance が入らず、ログブックやランキングの
 * 合計飛行距離が 0 のままになっていた。その対策として、空港座標の
 * 静的データ (src/data/airports.json) を持ち、出発・到着コードから
 * 大圏距離を算出する。
 *
 * airports.json は OurAirports (https://ourairports.com/, パブリック
 * ドメイン) の airports.csv から、large/medium/small 空港の
 * ICAO コード (icao_code → gps_code → ident の順) と座標だけを
 * 抽出したもの。
 */

"use strict";

let airports = null;
function load() {
  if (airports) return airports;
  try {
    airports = require("../data/airports.json");
  } catch {
    airports = {};
  }
  return airports;
}

const EARTH_RADIUS_NM = 3440.065; // 地球の平均半径 (海里)
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * 2つの ICAO コード間の大圏距離 (nm, 整数)。どちらかの空港が
 * データに無い場合は null を返す。
 */
function distanceNmBetween(originIcao, destIcao) {
  const table = load();
  const a = table[String(originIcao || "").toUpperCase()];
  const b = table[String(destIcao || "").toUpperCase()];
  if (!a || !b) return null;

  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const d = 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(d);
}

module.exports = { distanceNmBetween };
