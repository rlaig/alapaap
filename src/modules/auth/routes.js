'use strict';

const express = require('express');
const router = express.Router();
const { verifyPassword, findById, changePassword } = require('./user-model');
const { signToken } = require('../../core/auth');
const audit = require('../../core/audit-log');
const config = require('../../../config/default');

function sessionCookieOpts(extra = {}) {
  const o = { httpOnly: true, sameSite: 'strict', path: '/', ...extra };
  if (config.cookieSecure) o.secure = true;
  return o;
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.socket?.remoteAddress;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = verifyPassword(username, password);
  if (!user) {
    audit.log('login_failed', { target: username, ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ id: user.id, username: user.username, role: user.role });
  audit.log('login_success', { userId: user.id, target: user.username, ip });

  res.cookie(config.auth.cookieName, token, sessionCookieOpts({
    maxAge: 8 * 60 * 60 * 1000,
  }));

  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.auth.cookieName, sessionCookieOpts());
  if (req.user) {
    audit.log('logout', { userId: req.user.id, ip: req.ip });
  }
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/change-password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    changePassword(req.user.id, currentPassword, newPassword);
    audit.log('password_changed', { userId: req.user.id, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/audit-log', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const entries = audit.query({ limit });
  res.json(entries);
});

module.exports = router;
