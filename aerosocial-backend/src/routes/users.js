const express = require("express");
const pool = require("../db");

const router = express.Router();

router.get("/:callsign", async (req, res) => {
  const cs = req.params.callsign.toUpperCase();
  const userResult = await pool.query("SELECT * FROM users WHERE callsign = $1", [cs]);
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: "パイロットが見つかりません。" });

  const stats = await pool.query(
    `SELECT COUNT(*) AS flight_count,
            COALESCE(SUM((flight->>'durMin')::int), 0) AS total_min,
            COALESCE(SUM((flight->>'distance')::int), 0) AS total_nm
     FROM posts WHERE author_id = $1 AND type = 'flight'`,
    [user.id]
  );

  res.json({
    user: {
      id: user.id, callsign: user.callsign, name: user.name,
      homeBase: user.home_base, bio: user.bio, hue: user.hue, joined: user.created_at,
    },
    stats: {
      flights: Number(stats.rows[0].flight_count),
      hours: Number(stats.rows[0].total_min) / 60,
      distanceNm: Number(stats.rows[0].total_nm),
    },
  });
});

module.exports = router;
