/**
 * src/routes/logbook.js
 * ---------------------------------------------------------------
 * GET /api/logbook/leaderboard — the public, "everyone can see it"
 * ranking (distinct from the admin panel's own stats tab, which is
 * admin-only and about the platform as a whole rather than per-pilot
 * rankings). Aggregated straight from `posts` at request time, same as
 * flightStats.js/achievements.js — no separate leaderboard table to keep
 * in sync.
 */

"use strict";

const express = require("express");
const pool = require("../db");
const { optionalAuth } = require("../middleware/auth");

const router = express.Router();

const METRICS = {
  distance: "total_nm",
  hours: "total_min",
  flights: "flight_count",
};

function shapeEntry(row, rank) {
  return {
    rank,
    user: {
      callsign: row.callsign,
      name: row.name,
      hue: row.hue,
      avatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    },
    flights: Number(row.flight_count),
    hours: Number(row.total_min) / 60,
    distanceNm: Number(row.total_nm),
  };
}

// GET /api/logbook/leaderboard?period=month|all&metric=distance|hours|flights&limit=20
// optionalAuth: logged-out visitors get the public top list with no `me`
// entry; a logged-in pilot also gets their own rank/totals for that same
// period+metric, even if they're outside the returned top `limit`.
router.get("/leaderboard", optionalAuth, async (req, res) => {
  try {
    const period = req.query.period === "all" ? "all" : "month";
    const metricKey = METRICS[req.query.metric] ? req.query.metric : "distance";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    // A fixed literal, not user input — no placeholder/param needed here.
    const periodClause =
      period === "month" ? "AND p.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of month')" : "";

    // Every pilot's totals for the period, unsliced — small enough for this
    // community's scale to just sort in JS, which also makes finding the
    // requesting pilot's own rank (even if outside the top `limit`) trivial
    // instead of needing a second correlated-subquery/window-function
    // query just for that.
    const result = await pool.query(
      `SELECT u.id, u.callsign, u.name, u.hue, u.avatar_path,
              COUNT(*) AS flight_count,
              COALESCE(SUM(CAST(json_extract(p.flight, '$.durMin') AS INTEGER)), 0) AS total_min,
              COALESCE(SUM(CAST(json_extract(p.flight, '$.distance') AS INTEGER)), 0) AS total_nm
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.type = 'flight' ${periodClause}
       GROUP BY u.id`
    );

    const metricColumn = METRICS[metricKey];
    const sorted = result.rows
      .map((r) => ({ ...r, metricValue: Number(r[metricColumn]) }))
      .sort((a, b) => b.metricValue - a.metricValue);

    const entries = sorted.slice(0, limit).map((row, i) => shapeEntry(row, i + 1));

    let me = null;
    if (req.user) {
      const idx = sorted.findIndex((r) => r.id === req.user.id);
      if (idx !== -1) me = shapeEntry(sorted[idx], idx + 1);
    }

    res.json({ period, metric: metricKey, entries, me });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ランキングの取得に失敗しました。" });
  }
});

module.exports = router;
