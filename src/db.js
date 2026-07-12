const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.SQLITE_PATH || path.resolve(__dirname, "..", "aerosocial.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Converts Postgres-style $1, $2, ... placeholders (used sequentially and
// never reused/reordered anywhere in this codebase) into SQLite's `?`.
function toSqliteSql(sql) {
  return sql.replace(/\$\d+/g, "?");
}

// Minimal drop-in replacement for the subset of the `pg` Pool interface
// this codebase relies on: `pool.query(sql, params) -> { rows, rowCount }`.
// better-sqlite3 is synchronous under the hood, but we still return a
// Promise so every existing `await pool.query(...)` call site keeps working
// unchanged.
function query(sql, params = []) {
  try {
    const stmt = sqlite.prepare(toSqliteSql(sql));
    const returnsRows = /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql);
    if (returnsRows) {
      const rows = stmt.all(...params);
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    const info = stmt.run(...params);
    return Promise.resolve({ rows: [], rowCount: info.changes });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { query, raw: sqlite };
