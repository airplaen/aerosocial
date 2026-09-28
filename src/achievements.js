/**
 * src/achievements.js
 * ---------------------------------------------------------------
 * Badge definitions + computeAchievements(), used by
 * GET /api/users/:callsign/achievements (routes/users.js). Everything here
 * is computed on the fly from flightStats.js's aggregates rather than
 * stored/unlocked server-side — there's no "achievements" table, so a
 * badge's earned/locked state is always exactly consistent with the
 * pilot's current flight history (edit/delete a flight post and the badge
 * list reflects that immediately, nothing to backfill or repair).
 */

"use strict";

// Each tier's `current`/`target` in the response is meant to drive a
// progress bar (current clamped to target once earned, so it always
// renders as "full" rather than overflowing).
const FLIGHT_TIERS = [
  { threshold: 1, icon: "🎉", label: "初フライト", description: "最初のフライトを記録した" },
  { threshold: 10, icon: "✈️", label: "10フライト達成", description: "フライト投稿が10件に到達した" },
  { threshold: 50, icon: "🛫", label: "50フライト達成", description: "フライト投稿が50件に到達した" },
  { threshold: 100, icon: "💯", label: "100フライト達成", description: "フライト投稿が100件に到達した" },
  { threshold: 250, icon: "🚀", label: "250フライト達成", description: "フライト投稿が250件に到達した" },
];

const HOUR_TIERS = [
  { threshold: 10, icon: "⏱️", label: "飛行時間10時間達成", description: "累計飛行時間が10時間に到達した" },
  { threshold: 50, icon: "🕐", label: "飛行時間50時間達成", description: "累計飛行時間が50時間に到達した" },
  { threshold: 100, icon: "🏅", label: "飛行時間100時間達成", description: "累計飛行時間が100時間に到達した" },
  { threshold: 500, icon: "🏆", label: "飛行時間500時間達成", description: "累計飛行時間が500時間に到達した" },
  { threshold: 1000, icon: "👑", label: "飛行時間1,000時間達成", description: "累計飛行時間が1,000時間に到達した" },
];

const DISTANCE_TIERS = [
  { threshold: 1000, icon: "🗺️", label: "累計1,000nm到達", description: "累計飛行距離が1,000nmに到達した" },
  { threshold: 5000, icon: "🧭", label: "累計5,000nm到達", description: "累計飛行距離が5,000nmに到達した" },
  { threshold: 10000, icon: "🌍", label: "累計10,000nm到達", description: "累計飛行距離が10,000nmに到達した" },
  // 地球の赤道全周 ≈ 21,639nm。ちょうどそのくらい飛んだ、というフレーバー。
  { threshold: 21600, icon: "🌐", label: "地球一周相当(21,600nm)到達", description: "地球の全周にほぼ相当する距離を飛んだ" },
  { threshold: 50000, icon: "🛰️", label: "累計50,000nm到達", description: "累計飛行距離が50,000nmに到達した" },
];

const AIRPORT_TIERS = [
  { threshold: 5, icon: "🛬", label: "5空港に到着", description: "5つの異なる空港を発着した" },
  { threshold: 10, icon: "🗾", label: "10空港に到着", description: "10の異なる空港を発着した" },
  { threshold: 25, icon: "🌏", label: "25空港に到着", description: "25の異なる空港を発着した" },
  { threshold: 50, icon: "🛰️", label: "50空港に到着", description: "50の異なる空港を発着した" },
];

// 特定空港到着バッジ。日本の主要空港+ 世界の主要ハブを中心に、あえて
// 「よく飛ぶ路線」を選定 — フライトシムコミュニティでの人気路線と重なる
// ようにしている。出発・到着どちらでも達成扱い(flightStats.getAirports()
// が出発/到着を区別せず1つのリストにまとめているのと同じ考え方)。
const LANDMARK_AIRPORTS = [
  { icao: "RJTT", name: "東京国際空港(羽田)" },
  { icao: "RJAA", name: "成田国際空港" },
  { icao: "RJBB", name: "関西国際空港" },
  { icao: "RJCC", name: "新千歳空港" },
  { icao: "ROAH", name: "那覇空港" },
  { icao: "RJFF", name: "福岡空港" },
  { icao: "KJFK", name: "ニューヨーク・JFK国際空港" },
  { icao: "KLAX", name: "ロサンゼルス国際空港" },
  { icao: "EGLL", name: "ロンドン・ヒースロー空港" },
  { icao: "LFPG", name: "パリ・シャルル・ド・ゴール空港" },
  { icao: "EDDF", name: "フランクフルト空港" },
  { icao: "OMDB", name: "ドバイ国際空港" },
  { icao: "WSSS", name: "シンガポール・チャンギ空港" },
  { icao: "YSSY", name: "シドニー・キングスフォード・スミス空港" },
  { icao: "VHHH", name: "香港国際空港" },
];

function tierAchievements(tiers, currentValue, category) {
  return tiers.map((tier) => ({
    id: `${category}_${tier.threshold}`,
    category,
    icon: tier.icon,
    label: tier.label,
    description: tier.description,
    earned: currentValue >= tier.threshold,
    current: Math.min(currentValue, tier.threshold),
    target: tier.threshold,
  }));
}

function landmarkAchievements(airports) {
  const byIcao = new Map(airports.map((a) => [a.icao, a]));
  return LANDMARK_AIRPORTS.map((l) => {
    const match = byIcao.get(l.icao);
    return {
      id: `landmark_${l.icao}`,
      category: "landmark",
      icon: "📍",
      label: `${l.name}に到着`,
      description: `${l.name}(${l.icao})を発着した`,
      earned: !!match,
      earnedAt: match ? match.firstVisitAt : null,
    };
  });
}

// `totals` is flightStats.getTotals()'s return value; `airports` is the
// *unsliced* flightStats.getAirports() list (every airport ever touched —
// landmark matching needs the full list, not just a display-sized slice).
function computeAchievements({ totals, airports }) {
  const hoursRounded = Math.round(totals.hours * 10) / 10;
  const distanceRounded = Math.round(totals.distanceNm);
  const achievements = [
    ...tierAchievements(FLIGHT_TIERS, totals.flights, "flights"),
    ...tierAchievements(HOUR_TIERS, hoursRounded, "hours"),
    ...tierAchievements(DISTANCE_TIERS, distanceRounded, "distance"),
    ...tierAchievements(AIRPORT_TIERS, airports.length, "airports"),
    ...landmarkAchievements(airports),
  ];
  return {
    achievements,
    earnedCount: achievements.filter((a) => a.earned).length,
    totalCount: achievements.length,
  };
}

module.exports = { computeAchievements, LANDMARK_AIRPORTS };
