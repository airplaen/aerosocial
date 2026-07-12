require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "aerosocial.db");
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");

  console.log(`Applying schema.sql to ${dbPath} ...`);
  const db = new Database(dbPath);
  db.exec(sql);

  // For databases created before avatar support existed: CREATE TABLE IF
  // NOT EXISTS above won't add a column to an already-existing table, so
  // add it here and ignore the error if it's already present.
  try {
    db.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT");
    console.log("Added avatar_path column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  db.close();
  console.log("Done.");
}

main();
