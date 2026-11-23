/**
 * scripts/backfill-flight-distance.js
 * ---------------------------------------------------------------
 * 既存のフライト投稿のうち distance が入っていないもの (主に VATSIM
 * 由来) について、出発・到着の ICAO コードから大圏距離を計算して
 * posts.flight JSON に書き戻す一回限りの補完スクリプト。
 *
 * ログブック / ランキングの合計距離は posts.flight の distance を
 * 合算しているため、これを実行すると過去分の合計にも反映される。
 * distance が既にある投稿には触らないので、再実行しても安全。
 *
 * 実行: node scripts/backfill-flight-distance.js
 */

"use strict";

const pool = require("../src/db");
const { distanceNmBetween } = require("../src/lib/airportDistance");

function main() {
  const sqlite = pool.raw;
  const rows = sqlite
    .prepare("SELECT id, flight FROM posts WHERE type = 'flight' AND flight IS NOT NULL")
    .all();

  let updated = 0;
  let alreadyHad = 0;
  const unknown = new Set();

  const update = sqlite.prepare("UPDATE posts SET flight = ? WHERE id = ?");
  for (const row of rows) {
    let flight;
    try {
      flight = JSON.parse(row.flight);
    } catch {
      continue;
    }
    if (flight.distance != null) {
      alreadyHad += 1;
      continue;
    }
    const d = distanceNmBetween(flight.originIcao, flight.destIcao);
    if (d == null) {
      unknown.add(`${flight.originIcao || "?"}->${flight.destIcao || "?"}`);
      continue;
    }
    flight.distance = d;
    update.run(JSON.stringify(flight), row.id);
    updated += 1;
  }

  console.log(`対象フライト投稿: ${rows.length} 件`);
  console.log(`  distance を補完: ${updated} 件`);
  console.log(`  元々 distance あり: ${alreadyHad} 件`);
  if (unknown.size) {
    console.log(`  空港データに無く補完できなかったルート: ${[...unknown].join(", ")}`);
  }
}

main();
