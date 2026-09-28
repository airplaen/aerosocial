const express = require('express');
const passport = require('passport');
const { hasGoogleCredentials } = require('../auth');

const router = express.Router();

router.get('/google', (req, res, next) => {
  if (!hasGoogleCredentials) {
    return res
      .status(500)
      .send(
        'Google OAuthの設定が未完了です。.env の GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL を設定し、サーバーを再起動してください(README.md の「事前準備」参照)。'
      );
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  if (!hasGoogleCredentials) {
    return res.status(500).send('Google OAuthの設定が未完了です。.env を確認してください。');
  }
  passport.authenticate('google', { failureRedirect: '/?login=failed' })(req, res, next);
}, (req, res) => {
  res.redirect('/');
});

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
