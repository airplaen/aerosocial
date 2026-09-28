/**
 * src/flightStats.js
 * ---------------------------------------------------------------
 * Shared SQL for turning a pilot's `flight`-type posts into the
 * aggregates the logbook page, achievement badges, and leaderboard all
 * need (see routes/users.js's /:callsign/logbook + /:callsign/achievements,
 * and routes/logbook.js's /leaderboard). Pulled out into its own module so
 * none of those three re-implement the same json_extract() queries.
 *
 * `flight` is stored as a JSON string on `posts` (see routes/simbrief.js /
 * routes/fsaFlightPost.js for how it's built) — the field names read below
 * (originIcao, destIcao, aircraftIcao, distance, durMin, ...) are that same
 * shape, camelCased exactly as SimBrief/FSA produce it.
 */

"use strict";

const pool = require("./db");

// Returns { flights, hours, distanceNm, firstFlightAt, lastFlightAt } for
// one pilot, all-time. `hours` is already converted from durMin.
async function getTotals(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS flight_count,
            COALESCE(SUM(CAST(json_extract(flight, '$.durMin') AS INTEGER)), 0) AS total_min,
            COALESCE(SUM(CAST(json_extract(flight, '$.distance') AS INTEGER)), 0) AS total_nm,
            MIN(created_at) AS first_flight_at,
            MAX(created_at) AS last_flight_at
     FROM posts WHERE author_id = $1 AND type = 'flight'`,
    [userId]
  );
  const row = result.rows[0];
  return {
    flights: Number(row.flight_count),
    hours: Number(row.total_min) / 60,
    distanceNm: Number(row.total_nm),
    firstFlightAt: row.first_flight_at || null,
    lastFlightAt: row.last_flight_at || null,
  };
}

// Month-by-month totals for the last `months` calendar months (default 12),
// zero-filled so a quiet month still shows up as 0 instead of a gap — same
// "zero-fill in JS after a GROUP BY" recipe as
// GET /api/admin/stats/posts-timeseries (routes/admin.js).
async function getMonthly(userId, months = 12) {
  const result = await pool.query(
    `SELECT strftime('%Y-%m', created_at) AS month,
            COUNT(*) AS flight_count,
            COALESCE(SUM(CAST(json_extract(flight, '$.durMin') AS INTEGER)), 0) AS total_min,
            COALESCE(SUM(CAST(json_extract(flight, '$.distance') AS INTEGER)), 0) AS total_nm
     FROM posts
     WHERE author_id = $1 AND type = 'flight'
       AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of month', '-${months - 1} months')
     GROUP BY month
     ORDER BY month ASC`,
    [userId]
  );
  const byMonth = Object.fromEntries(result.rows.map((r) => [r.month, r]));
  const series = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() - (months - 1));
  for (let i = 0; i < months; i++) {
    const key = cursor.toISOString().slice(0, 7); // YYYY-MM
    const row = byMonth[key];
    series.push({
      month: key,
      flights: row ? Number(row.flight_count) : 0,
      hours: row ? Number(row.total_min) / 60 : 0,
      distanceNm: row ? Number(row.total_nm) : 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return series;
}

// Per-aircraft totals, most-flown-by-hours first. Grouped by ICAO type
// when available, falling back to the free-text aircraft name for the
// (rare) flight that has one but not the other — either way there's one
// row per distinct aircraft, not one row per missing-ICAO flight.
async function getAircraftBreakdown(userId, limit = 20) {
  const result = await pool.query(
    `SELECT key, MAX(icao) AS icao, MAX(name) AS name,
            COUNT(*) AS flight_count,
            COALESCE(SUM(CAST(dur_min AS INTEGER)), 0) AS total_min
     FROM (
       SELECT
         COALESCE(json_extract(flight, '$.aircraftIcao'), json_extract(flight, '$.aircraftName')) AS key,
         json_extract(flight, '$.aircraftIcao') AS icao,
         json_extract(flight, '$.aircraftName') AS name,
         json_extract(flight, '$.durMin') AS dur_min
       FROM posts
       WHERE author_id = $1 AND type = 'flight'
     ) t
     WHERE key IS NOT NULL AND key != ''
     GROUP BY key
     ORDER BY total_min DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map((r) => ({
    icao: r.icao || null,
    name: r.name || null,
    flights: Number(r.flight_count),
    hours: Number(r.total_min) / 60,
  }));
}

// Every airport that's shown up as either an origin or a destination,
// combined into one list (an airport a pilot always departs from and
// never lands at should still count as "visited"). `all` is unsliced —
// achievement matching needs to check every airport the pilot has ever
// touched, not just the top N shown on the logbook page — callers that
// only want a display list should slice it themselves.
async function getAirports(userId) {
  const result = await pool.query(
    `SELECT icao, MAX(name) AS name, COUNT(*) AS visits,
            SUM(CASE WHEN role = 'origin' THEN 1 ELSE 0 END) AS as_origin,
            SUM(CASE WHEN role = 'dest' THEN 1 ELSE 0 END) AS as_dest,
            MIN(created_at) AS first_visit_at
     FROM (
       SELECT json_extract(flight, '$.originIcao') AS icao,
              json_extract(flight, '$.originName') AS name,
              'origin' AS role, created_at
       FROM posts
       WHERE author_id = $1 AND type = 'flight'
         AND json_extract(flight, '$.originIcao') IS NOT NULL AND json_extract(flight, '$.originIcao') != ''
       UNION ALL
       SELECT json_extract(flight, '$.destIcao') AS icao,
              json_extract(flight, '$.destName') AS name,
              'dest' AS role, created_at
       FROM posts
       WHERE author_id = $2 AND type = 'flight'
         AND json_extract(flight, '$.destIcao') IS NOT NULL AND json_extract(flight, '$.destIcao') != ''
     ) t
     GROUP BY icao
     ORDER BY visits DESC, icao ASC`,
    [userId, userId]
  );
  return result.rows.map((r) => ({
    icao: r.icao,
    name: r.name || null,
    visits: Number(r.visits),
    asOrigin: Number(r.as_origin),
    asDest: Number(r.as_dest),
    firstVisitAt: r.first_visit_at || null,
  }));
}

// Most recent flights, compact form — enough for a "最近のフライト" table
// without pulling in the full post payload (images, likes, comments, ...)
// that the profile's 投稿 tab already covers.
async function getRecentFlights(userId, limit = 10) {
  const result = await pool.query(
    `SELECT id, created_at,
            json_extract(flight, '$.originIcao') AS origin_icao,
            json_extract(flight, '$.originName') AS origin_name,
            json_extract(flight, '$.destIcao') AS dest_icao,
            json_extract(flight, '$.destName') AS dest_name,
            json_extract(flight, '$.aircraftIcao') AS aircraft_icao,
            json_extract(flight, '$.aircraftName') AS aircraft_name,
            CAST(json_extract(flight, '$.distance') AS INTEGER) AS distance,
            CAST(json_extract(flight, '$.durMin') AS INTEGER) AS dur_min
     FROM posts
     WHERE author_id = $1 AND type = 'flight'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map((r) => ({
    postId: r.id,
    createdAt: r.created_at,
    originIcao: r.origin_icao || null,
    originName: r.origin_name || null,
    destIcao: r.dest_icao || null,
    destName: r.dest_name || null,
    aircraftIcao: r.aircraft_icao || null,
    aircraftName: r.aircraft_name || null,
    distanceNm: r.distance ?? null,
    durMin: r.dur_min ?? null,
  }));
}

module.exports = { getTotals, getMonthly, getAircraftBreakdown, getAirports, getRecentFlights };
