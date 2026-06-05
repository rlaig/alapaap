'use strict';

const buckets = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > bucket.windowMs * 2) {
      buckets.delete(key);
    }
  }
}

setInterval(cleanup, 60000).unref();

function rateLimit({ windowMs = 60000, max = 10, keyFn, message = 'Too many requests' } = {}) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0, windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

module.exports = { rateLimit };
