const session = require('express-session');
const db = require('./db');

const getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
const upsertStmt = db.prepare(
  `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
   ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
);
const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const clearStmt = db.prepare('DELETE FROM sessions');
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM sessions');
const allStmt = db.prepare('SELECT sid, sess FROM sessions');
const purgeExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?');

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // 期限切れセッションを1時間おきに掃除する
    this._cleanupTimer = setInterval(() => {
      try {
        purgeExpiredStmt.run(Date.now());
      } catch (err) {
        console.error('セッションの掃除に失敗:', err.message);
      }
    }, 60 * 60 * 1000);
    this._cleanupTimer.unref?.();
  }

  get(sid, callback) {
    try {
      const row = getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expires && row.expires < Date.now()) {
        destroyStmt.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expires = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : null;
      upsertStmt.run(sid, JSON.stringify(sessionData), expires);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      destroyStmt.run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }

  length(callback) {
    try {
      callback(null, countStmt.get().c);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      clearStmt.run();
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  all(callback) {
    try {
      const rows = allStmt.all();
      callback(null, rows.map((r) => JSON.parse(r.sess)));
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
