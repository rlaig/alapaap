'use strict';

const { getDb } = require('./database');

function log(action, { userId = null, target = null, ip = null, details = null } = {}) {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO audit_log (user_id, action, target, ip, details) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, action, target, ip, typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err.message);
  }
}

function query({ action, userId, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (action) {
    sql += ' AND action = ?';
    params.push(action);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(Math.min(limit, 200), offset);

  return db.prepare(sql).all(...params);
}

module.exports = { log, query };
