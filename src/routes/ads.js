const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/ads
// Public — every visitor's feed needs this, logged in or not, so unlike
// routes/admin.js this deliberately has no requireAuth/requireAdmin. It
// only ever exposes what the admin has explicitly set to be embedded
// directly into the page anyway (see routes/admin.js PUT /api/admin/ads).
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query("SELECT enabled, code, frequency FROM ad_settings WHERE id = 1");
    const row = result.rows[0];
    if (!row || !row.enabled || !row.code) {
      return res.json({ enabled: false, code: "", frequency: 5 });
    }
    res.json({ enabled: true, code: row.code, frequency: Number(row.frequency) || 5 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "広告設定の取得に失敗しました。" });
  }
});

module.exports = router;
