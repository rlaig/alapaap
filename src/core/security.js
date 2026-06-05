'use strict';

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.path.startsWith('/api/')) return next();

  const origin = req.headers.origin;
  const host = req.headers.host;

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return res.status(403).json({ error: 'Origin mismatch' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }

  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const ms = Date.now() - start;
      console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
}

module.exports = { securityHeaders, csrfProtection, requestLogger };
