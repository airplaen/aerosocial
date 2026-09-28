const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const crypto = require('crypto');
const db = require('./db');

const isPlaceholder = (v) => !v || v.startsWith('your-') || v.startsWith('dummy-');

const hasGoogleCredentials =
  !isPlaceholder(process.env.GOOGLE_CLIENT_ID) &&
  !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET) &&
  !isPlaceholder(process.env.GOOGLE_CALLBACK_URL);

if (hasGoogleCredentials) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
          if (existing) {
            db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ? WHERE id = ?').run(
              profile.displayName,
              profile.emails?.[0]?.value || null,
              profile.photos?.[0]?.value || null,
              existing.id
            );
            return done(null, { ...existing, name: profile.displayName });
          }

          const id = crypto.randomUUID();
          db.prepare(
            'INSERT INTO users (id, google_id, email, name, avatar_url) VALUES (?, ?, ?, ?, ?)'
          ).run(id, profile.id, profile.emails?.[0]?.value || null, profile.displayName, profile.photos?.[0]?.value || null);

          return done(null, { id, google_id: profile.id, name: profile.displayName, email: profile.emails?.[0]?.value });
        } catch (err) {
          return done(err);
        }
      }
    )
  );
} else {
  console.warn(
    '[起動時の警告] Google OAuthの設定が未完了です(.env の GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL を確認してください)。'
    + ' ログイン機能は動作しません。README.md の「事前準備」を参照してください。'
  );
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

module.exports = passport;
module.exports.hasGoogleCredentials = hasGoogleCredentials;
