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

// GET /api/ads/frame
// Serves the admin's ad snippet inside its own, standalone HTML document
// instead of injecting it into the main app page (compare to how every
// other embedded script in this app runs — see injectHtmlWithScripts in
// app.js, which this replaces specifically for ads). Some ad networks
// (AdMax's own auto.js among them) render themselves via document.write() —
// a script inserted that way is "parser-inserted" under the CSP spec, and
// 'strict-dynamic' deliberately does not extend trust to parser-inserted
// scripts (that carve-out is what stops 'strict-dynamic' from being
// trivially bypassed) — so under this app's normal nonce/strict-dynamic
// script-src (see index.js) it's silently blocked no matter what DOM API
// app.js used to insert the ad network's own loader script in the first
// place. A separate, unrestricted document sidesteps that entirely:
// document.write works exactly like it would on any ordinary web page with
// no CSP. The frame reports its own rendered height back to the parent via
// postMessage so the parent can size the iframe — the ad creative's actual
// dimensions vary by ad unit and aren't known ahead of time (see the
// "message" listener in app.js's renderFeedList).
router.get("/frame", async (_req, res) => {
  try {
    const result = await pool.query("SELECT enabled, code FROM ad_settings WHERE id = 1");
    const row = result.rows[0];
    const code = row && row.enabled ? (row.code || "") : "";

    // helmet() sets a Content-Security-Policy on every response by default
    // (it's global, app-level middleware run ahead of routing) — remove it
    // here so this one document is unrestricted. A *more permissive* CSP
    // value would not be enough: even 'unsafe-inline' alone doesn't cover
    // document.write-inserted scripts, only a genuine absence of the header
    // does (see the big comment above).
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }</style>
</head>
<body>
${code}
<script>
  // The ad network's own script renders asynchronously (and, per the
  // comment above, sometimes via document.write), so its final size isn't
  // known at load time — report it to the parent repeatedly for the first
  // few seconds, then whenever anything in the document actually changes.
  function reportHeight() {
    parent.postMessage({ source: "aerosocial-ad-frame", height: document.documentElement.scrollHeight }, "*");
  }
  window.addEventListener("load", reportHeight);
  new MutationObserver(reportHeight).observe(document.body, { childList: true, subtree: true, attributes: true });
  [300, 800, 1500, 3000].forEach((ms) => setTimeout(reportHeight, ms));
</script>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("");
  }
});

module.exports = router;
