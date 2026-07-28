const express = require("express");

const router = express.Router();

// Only ever proxy an actual youtube.com/youtu.be URL — this route is
// intentionally unauthenticated (anonymous viewers see post previews too),
// so it must never be usable as an open fetch-any-URL proxy.
const ALLOWED_HOSTS = new Set(["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"]);

// Pulls the 11-character video id out of any of the URL shapes app.js's
// extractYouTubeId() can match (watch?v=, shorts/, embed/, live/, youtu.be/),
// so the live-status lookup below doesn't need the frontend to pass the id
// separately.
function extractVideoId(videoUrl) {
  try {
    const u = new URL(videoUrl);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// GET /api/youtube/oembed?url=<YouTube video URL>
//
// Server-side proxy for YouTube's public, unauthenticated oEmbed endpoint:
//   https://www.youtube.com/oembed?url=<video url>&format=json
// The frontend can't call youtube.com directly from the browser (CORS), so
// this route fetches it here and returns just the fields the video card
// needs. No API key is required for the oEmbed part — it only exposes
// title, author (channel) name, and thumbnail.
//
// Whether the video is a currently-live broadcast isn't part of oEmbed's
// response, though, so that part is best-effort: if YOUTUBE_API_KEY is set
// (YouTube Data API v3, "videos.list" scope — free tier), `live` is filled
// in from `snippet.liveBroadcastContent` ("live" | "upcoming" | "none").
// Without a key configured, `live` stays null and the card just shows the
// normal YouTube badge instead of a LIVE one — the thumbnail/title/channel
// still work fine either way.
router.get("/oembed", async (req, res) => {
  try {
    const videoUrl = String(req.query.url || "").trim();
    if (!videoUrl) {
      return res.status(400).json({ error: "動画URLを指定してください。" });
    }

    let parsed;
    try {
      parsed = new URL(videoUrl);
    } catch {
      return res.status(400).json({ error: "動画URLが不正です。" });
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return res.status(400).json({ error: "対応していないURLです。" });
    }

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
    const upstream = await fetch(oembedUrl);
    if (!upstream.ok) {
      // Most commonly a private/deleted/age-restricted video — oEmbed
      // returns 401/404 for those rather than a normal error body.
      return res.status(404).json({ error: "動画情報が見つかりませんでした。" });
    }

    const raw = await upstream.json();

    let live = null;
    if (process.env.YOUTUBE_API_KEY) {
      const videoId = extractVideoId(videoUrl);
      if (videoId) {
        try {
          const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${process.env.YOUTUBE_API_KEY}`;
          const liveRes = await fetch(apiUrl);
          if (liveRes.ok) {
            const liveData = await liveRes.json();
            const snippet = liveData.items && liveData.items[0] && liveData.items[0].snippet;
            if (snippet && snippet.liveBroadcastContent) live = snippet.liveBroadcastContent;
          }
        } catch {
          // Live-status lookup is a best-effort enhancement — the oEmbed
          // data already fetched above is still returned either way.
        }
      }
    }

    res.json({
      title: raw.title || null,
      authorName: raw.author_name || null,
      thumbnailUrl: raw.thumbnail_url || null,
      live, // "live" | "upcoming" | "none" | null (null = unknown / not configured)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "動画情報の取得に失敗しました。" });
  }
});

module.exports = router;
