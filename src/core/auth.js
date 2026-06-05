'use strict';

const jwt = require('jsonwebtoken');
const { getDb } = require('./database');
const config = require('../../config/default');

function getJwtSecret() {
  const db = getDb();
  let row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  if (!row) {
    const crypto = require('crypto');
    const secret = crypto.randomBytes(64).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
    row = { value: secret };
  }
  return row.value;
}

function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: config.auth.jwtExpiry });
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function extractToken(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookies = req.headers?.cookie;
  if (cookies) {
    const match = cookies.split(';').find(c => c.trim().startsWith(config.auth.cookieName + '='));
    if (match) {
      return match.split('=')[1].trim();
    }
  }
  return null;
}

const PUBLIC_PATHS = ['/api/auth/login', '/api/health'];

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next();

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function authenticateWs(token) {
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

module.exports = { signToken, verifyToken, extractToken, requireAuth, requireRole, authenticateWs, getJwtSecret };
