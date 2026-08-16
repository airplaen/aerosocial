const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { broadcast } = require("../ws");
const { notifyNewEvent } = require("../services/discordNotify");

const router = express.Router();

const TITLE_MAX_LEN = 100;
const DESCRIPTION_MAX_LEN = 2000;
const LOCATION_MAX_LEN = 100;
const ICAO_MAX_LEN = 10;
const MAX_CAPACITY = 500;

function serializeEvent(row, viewerId) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorCallsign: row.callsign,
    creatorName: row.name,
    creatorHue: row.hue,
    creatorAvatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    eventType: row.event_type,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    departureIcao: row.departure_icao,
    arrivalIcao: row.arrival_icao,
    capacity: row.capacity,
    notifyDiscord: !!row.notify_discord,
    participantCount: Number(row.participant_count || 0),
    isJoined: viewerId ? !!row.is_joined : false,
    isMine: viewerId ? row.creator_id === viewerId : false,
    createdAt: row.created_at,
  };
}

// Shared SELECT for list/detail: participant_count via a correlated
// subquery, is_joined via a LEFT JOIN against the viewer's own row only
// (both patterns mirror loadPollsForPosts / the likes handling in
// routes/posts.js).
function buildListQuery({ scope, viewerId }) {
  const params = [];
  let where = "1 = 1";
  if (scope === "past") {
    where = "e.starts_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  } else if (scope === "upcoming") {
    where = "e.starts_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  }

  params.push(viewerId || null);
  const sql = `
    SELECT e.*, u.callsign, u.name, u.hue, u.avatar_path,
           (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) AS participant_count,
           EXISTS(SELECT 1 FROM event_participants ep2 WHERE ep2.event_id = e.id AND ep2.user_id = $1) AS is_joined
    FROM events e
    JOIN users u ON u.id = e.creator_id
    WHERE ${where}
    ORDER BY e.starts_at ${scope === "past" ? "DESC" : "ASC"}
  `;
  return { sql, params };
}

// GET /api/events?scope=upcoming|past|all (default: upcoming)
router.get("/", optionalAuth, async (req, res) => {
  try {
    const scope = ["upcoming", "past", "all"].includes(req.query.scope) ? req.query.scope : "upcoming";
    const { sql, params } = buildListQuery({ scope, viewerId: req.user?.id });
    const result = await pool.query(sql, params);
    res.json({ events: result.rows.map((row) => serializeEvent(row, req.user?.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "イベント一覧の取得に失敗しました。" });
  }
});

// GET /api/events/:id
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    // NOTE: db.js's $N -> "?" conversion binds purely by the order $N
    // tokens appear in the SQL text (see its own comment), not by their
    // numeric label — so viewerId is $1 here (it appears first, inside
    // the EXISTS subquery) and the event id is $2 (appears second, in
    // WHERE), matching the params array order below exactly.
    const result = await pool.query(
      `SELECT e.*, u.callsign, u.name, u.hue, u.avatar_path,
              (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) AS participant_count,
              EXISTS(SELECT 1 FROM event_participants ep2 WHERE ep2.event_id = e.id AND ep2.user_id = $1) AS is_joined
       FROM events e
       JOIN users u ON u.id = e.creator_id
       WHERE e.id = $2`,
      [req.user?.id || null, req.params.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "イベントが見つかりません。" });

    const participantsResult = await pool.query(
      `SELECT u.callsign, u.name, u.hue, u.avatar_path, ep.created_at AS joined_at
       FROM event_participants ep
       JOIN users u ON u.id = ep.user_id
       WHERE ep.event_id = $1
       ORDER BY ep.created_at ASC`,
      [req.params.id]
    );

    res.json({
      event: serializeEvent(row, req.user?.id),
      participants: participantsResult.rows.map((p) => ({
        callsign: p.callsign,
        name: p.name,
        hue: p.hue,
        avatarUrl: p.avatar_path ? `/uploads/${p.avatar_path}` : null,
        joinedAt: p.joined_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "イベントの取得に失敗しました。" });
  }
});

// Validates the create/update body shared shape. Returns { error } or
// { values } with every field normalized (trimmed strings, null for
// blanks, numbers coerced).
function validateEventInput(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title || "").trim();
    if (!title) return { error: "タイトルを入力してください。" };
    if (title.length > TITLE_MAX_LEN) return { error: `タイトルは${TITLE_MAX_LEN}文字以内で入力してください。` };
    out.title = title;
  }

  if (!partial || body.eventType !== undefined) {
    const eventType = body.eventType === "flight" ? "flight" : "general";
    out.eventType = eventType;
  }

  if (!partial || body.description !== undefined) {
    const description = String(body.description || "").trim();
    if (description.length > DESCRIPTION_MAX_LEN) {
      return { error: `説明は${DESCRIPTION_MAX_LEN}文字以内で入力してください。` };
    }
    out.description = description || null;
  }

  if (!partial || body.startsAt !== undefined) {
    const startsAtDate = new Date(body.startsAt);
    if (!body.startsAt || Number.isNaN(startsAtDate.getTime())) {
      return { error: "開催日時が不正です。" };
    }
    out.startsAt = startsAtDate.toISOString();
  }

  if (body.endsAt !== undefined) {
    if (body.endsAt) {
      const endsAtDate = new Date(body.endsAt);
      if (Number.isNaN(endsAtDate.getTime())) return { error: "終了日時が不正です。" };
      out.endsAt = endsAtDate.toISOString();
    } else {
      out.endsAt = null;
    }
  }

  if (body.location !== undefined) {
    const location = String(body.location || "").trim();
    if (location.length > LOCATION_MAX_LEN) return { error: `場所は${LOCATION_MAX_LEN}文字以内で入力してください。` };
    out.location = location || null;
  }

  if (body.departureIcao !== undefined) {
    const departureIcao = String(body.departureIcao || "").trim().toUpperCase();
    if (departureIcao.length > ICAO_MAX_LEN) return { error: "出発空港コードが長すぎます。" };
    out.departureIcao = departureIcao || null;
  }

  if (body.arrivalIcao !== undefined) {
    const arrivalIcao = String(body.arrivalIcao || "").trim().toUpperCase();
    if (arrivalIcao.length > ICAO_MAX_LEN) return { error: "到着空港コードが長すぎます。" };
    out.arrivalIcao = arrivalIcao || null;
  }

  if (body.capacity !== undefined) {
    if (body.capacity === null || body.capacity === "") {
      out.capacity = null;
    } else {
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        return { error: `定員は1〜${MAX_CAPACITY}の整数で指定してください。` };
      }
      out.capacity = capacity;
    }
  }

  if (body.notifyDiscord !== undefined) {
    out.notifyDiscord = body.notifyDiscord ? 1 : 0;
  }

  return { values: out };
}

// POST /api/events
router.post("/", requireAuth, async (req, res) => {
  const { error, values } = validateEventInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO events
         (id, creator_id, event_type, title, description, starts_at, ends_at,
          location, departure_icao, arrival_icao, capacity, notify_discord)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        req.user.id,
        values.eventType,
        values.title,
        values.description ?? null,
        values.startsAt,
        values.endsAt ?? null,
        values.location ?? null,
        values.departureIcao ?? null,
        values.arrivalIcao ?? null,
        values.capacity ?? null,
        values.notifyDiscord ?? 0,
      ]
    );
    // Creating an event doesn't automatically RSVP the creator — join is a
    // separate explicit action, same as everyone else, so their own
    // capacity slot isn't silently consumed if they're only organizing it.

    const result = await pool.query(
      `SELECT e.*, u.callsign, u.name, u.hue, u.avatar_path, 0 AS participant_count, 0 AS is_joined
       FROM events e JOIN users u ON u.id = e.creator_id WHERE e.id = $1`,
      [id]
    );
    const event = serializeEvent(result.rows[0], req.user.id);

    broadcast("event:created", { id });
    if (values.notifyDiscord) {
      notifyNewEvent({
        callsign: req.user.callsign,
        title: values.title,
        description: values.description,
        startsAt: values.startsAt,
        eventId: id,
      });
    }

    res.status(201).json({ event });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "イベントの作成に失敗しました。" });
  }
});

// PATCH /api/events/:id — creator or admin only
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    const event = existing.rows[0];
    if (!event) return res.status(404).json({ error: "イベントが見つかりません。" });

    if (event.creator_id !== req.user.id) {
      const adminCheck = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.id]);
      if (!adminCheck.rows[0]?.is_admin) {
        return res.status(403).json({ error: "このイベントを編集する権限がありません。" });
      }
    }

    const { error, values } = validateEventInput(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(values).length) return res.status(400).json({ error: "更新する項目がありません。" });

    const columnMap = {
      eventType: "event_type",
      title: "title",
      description: "description",
      startsAt: "starts_at",
      endsAt: "ends_at",
      location: "location",
      departureIcao: "departure_icao",
      arrivalIcao: "arrival_icao",
      capacity: "capacity",
      notifyDiscord: "notify_discord",
    };
    const setClauses = [];
    const params = [];
    Object.entries(values).forEach(([key, val]) => {
      params.push(val);
      setClauses.push(`${columnMap[key]} = $${params.length}`);
    });
    // updated_at is computed server-side (not bound as a param) so it
    // always reflects the DB's own clock.
    setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    params.push(req.params.id);

    await pool.query(
      `UPDATE events SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
      params
    );

    broadcast("event:updated", { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "イベントの更新に失敗しました。" });
  }
});

// DELETE /api/events/:id — creator or admin only
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query("SELECT creator_id FROM events WHERE id = $1", [req.params.id]);
    const event = existing.rows[0];
    if (!event) return res.status(404).json({ error: "イベントが見つかりません。" });

    if (event.creator_id !== req.user.id) {
      const adminCheck = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.id]);
      if (!adminCheck.rows[0]?.is_admin) {
        return res.status(403).json({ error: "このイベントを削除する権限がありません。" });
      }
    }

    await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
    broadcast("event:deleted", { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "イベントの削除に失敗しました。" });
  }
});

// POST /api/events/:id/join
router.post("/:id/join", requireAuth, async (req, res) => {
  try {
    const eventResult = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    const event = eventResult.rows[0];
    if (!event) return res.status(404).json({ error: "イベントが見つかりません。" });

    const already = await pool.query(
      "SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (already.rows[0]) return res.json({ ok: true, alreadyJoined: true });

    if (event.capacity != null) {
      const countResult = await pool.query(
        "SELECT COUNT(*) AS c FROM event_participants WHERE event_id = $1",
        [req.params.id]
      );
      if (Number(countResult.rows[0].c) >= event.capacity) {
        return res.status(409).json({ error: "定員に達しています。" });
      }
    }

    await pool.query(
      "INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)",
      [req.params.id, req.user.id]
    );
    broadcast("event:participants", { id: req.params.id });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "参加登録に失敗しました。" });
  }
});

// POST /api/events/:id/leave
router.post("/:id/leave", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM event_participants WHERE event_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    broadcast("event:participants", { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "参加取り消しに失敗しました。" });
  }
});

module.exports = router;
