const webpush = require("web-push");
const pool = require("../db");

// VAPID keys identify this server to the push services (FCM, Mozilla's
// autopush, etc). Generate a pair once with `npx web-push generate-vapid-keys`
// and set them as env vars — they should stay constant across deploys,
// since browsers re-use their existing subscription tied to the public key.
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn(
    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — push notifications are disabled. " +
    "Generate a pair with `npx web-push generate-vapid-keys` and add them to .env."
  );
}

async function sendToRow(row, payload) {
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // 404/410 means the push service considers this subscription gone
    // (uninstalled, permission revoked, browser data cleared, ...) — clean
    // it up so future notifications don't keep retrying it.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
    } else {
      console.error("push send failed:", err.statusCode || err.message);
    }
  }
}

// Sends `payload` (plain object, JSON-serialized) to every push subscription
// belonging to any of `userIds`. `excludeUserId` is always skipped (e.g. an
// author never gets pushed their own post). No-ops silently if VAPID keys
// aren't configured, so callers don't need to check `enabled` themselves.
async function pushToUsers(userIds, payload, excludeUserId = null) {
  if (!enabled) return;
  const ids = [...new Set(userIds)].filter((id) => id && id !== excludeUserId);
  if (!ids.length) return;

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`,
    ids
  );
  await Promise.all(result.rows.map((row) => sendToRow(row, payload)));
}

// Sends `payload` to every push subscription in the system, e.g. an
// admin-broadcast announcement. `excludeUserId` skips one user's own
// subscriptions (the admin who sent it, so they don't get pushed their own
// announcement). No-ops silently if VAPID keys aren't configured.
async function pushToAll(payload, excludeUserId = null) {
  if (!enabled) return;
  const query = excludeUserId
    ? "SELECT * FROM push_subscriptions WHERE user_id != $1"
    : "SELECT * FROM push_subscriptions";
  const result = await pool.query(query, excludeUserId ? [excludeUserId] : []);
  await Promise.all(result.rows.map((row) => sendToRow(row, payload)));
}

module.exports = { pushToUsers, pushToAll, enabled, PUBLIC_KEY };
