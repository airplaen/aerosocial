// One-off CLI helper to grant admin rights, since there's no admin yet the
// first time this runs (nothing in the admin panel itself can do it).
//
// Usage:
//   node scripts/make-admin.js CALLSIGN
//   node scripts/make-admin.js CALLSIGN --revoke   (remove admin rights)
require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");

function main() {
  const callsign = String(process.argv[2] || "").trim().toUpperCase();
  const revoke = process.argv.includes("--revoke");

  if (!callsign) {
    console.error("Usage: node scripts/make-admin.js CALLSIGN [--revoke]");
    process.exit(1);
  }

  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "aerosocial.db");
  const db = new Database(dbPath);

  const user = db.prepare("SELECT id, callsign, is_admin FROM users WHERE callsign = ?").get(callsign);
  if (!user) {
    console.error(`No user found with callsign "${callsign}".`);
    db.close();
    process.exit(1);
  }

  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(revoke ? 0 : 1, user.id);
  console.log(`${callsign}: is_admin = ${revoke ? 0 : 1}`);
  db.close();
}

main();
