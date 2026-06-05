'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/default');
const audit = require('../../core/audit-log');

const AUTH_DB_PATH = config.receiptScannerLogs.authDbPath;

// --- Column detection (probes schema once; safe on readonly DBs) ---

const _columns = { loaded: false };

function detectColumns(db) {
  if (_columns.loaded) return _columns;
  const probe = (table, col) => {
    try { return db.prepare(`SELECT "${col}" FROM "${table}" LIMIT 0`).get(); return true; }
    catch { return false; }
  };
  _columns.receiptStatus     = probe('receipts',   'status');
  _columns.receiptMerchant   = probe('receipts',   'merchant_name');
  _columns.receiptAmount    = probe('receipts',   'total_amount');
  _columns.receiptCurrency  = probe('receipts',   'currency');
  _columns.receiptFileSize  = probe('receipts',   'file_size');
  _columns.receiptCategory  = probe('receipts',   'category');
  _columns.receiptSource    = probe('receipts',   'source');
  _columns.receiptError     = probe('receipts',   'error_message');
  _columns.userActive       = probe('users',      'is_active');
  _columns.userLastLogin    = probe('users',      'last_login_at');
  _columns.userLoginCount   = probe('users',      'login_count');
  _columns.userVerified     = probe('users',      'email_verified_at');
  _columns.usageAgent       = probe('usage_logs', 'user_agent');
  _columns.usageCredits     = probe('usage_logs', 'credits_used');
  _columns.usageDetails     = probe('usage_logs', 'details');
  _columns.usageDeviceId    = probe('usage_logs', 'device_id');
  _columns.loaded = true;
  return _columns;
}

function cols() { return _columns; }

// --- Migration system ---

const AUTH_DB_MIGRATIONS = [
  {
    version: 1,
    up(db) {
      // receipts table — 8 new columns
      const receiptCols = [
        ['status',         'TEXT DEFAULT \'completed\''],
        ['error_message',  'TEXT DEFAULT NULL'],
        ['merchant_name',  'TEXT DEFAULT NULL'],
        ['total_amount',   'REAL DEFAULT NULL'],
        ['currency',       'TEXT DEFAULT NULL'],
        ['file_size',      'INTEGER DEFAULT NULL'],
        ['category',       'TEXT DEFAULT NULL'],
        ['source',         'TEXT DEFAULT \'api\''],
      ];
      for (const [col, def] of receiptCols) {
        try { db.exec(`ALTER TABLE receipts ADD COLUMN ${col} ${def}`); }
        catch { /* column already exists */ }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_receipts_status   ON receipts(status);
        CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category);
        CREATE INDEX IF NOT EXISTS idx_receipts_merchant ON receipts(merchant_name);
      `);

      // users table — 4 new columns
      const userCols = [
        ['last_login_at',    'TEXT DEFAULT NULL'],
        ['login_count',      'INTEGER DEFAULT 0'],
        ['is_active',        'INTEGER DEFAULT 1'],
        ['email_verified_at','TEXT DEFAULT NULL'],
      ];
      for (const [col, def] of userCols) {
        try { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`); }
        catch { /* column already exists */ }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
      `);

      // usage_logs table — 3 new columns
      const usageCols = [
        ['user_agent',    'TEXT DEFAULT NULL'],
        ['details',       'TEXT DEFAULT NULL'],
        ['credits_used',  'INTEGER DEFAULT NULL'],
      ];
      for (const [col, def] of usageCols) {
        try { db.exec(`ALTER TABLE usage_logs ADD COLUMN ${col} ${def}`); }
        catch { /* column already exists */ }
      }
    },
  },
];

function ensureMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  const currentVersion = row?.v || 0;

  for (const migration of AUTH_DB_MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      })();
      console.log(`[receipt-scanner:auth-db] Applied migration v${migration.version}`);
    }
  }
}

function openDb(options = {}) {
  if (!fs.existsSync(AUTH_DB_PATH)) throw new Error('auth.db not found');
  const db = new Database(AUTH_DB_PATH, options);
  detectColumns(db);
  // Only run migrations when opened for writing; skip gracefully if DB is not writable
  if (!options.readonly) {
    try {
      ensureMigrations(db);
    } catch (err) {
      console.warn(`[receipt-scanner:auth-db] Migration skipped (DB not writable): ${err.message}`);
    }
  }
  return db;
}

// --- Overview ---

function getDbOverview() {
  const db = openDb({ readonly: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const stats = {};
    for (const t of tables) {
      const row = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
      stats[t.name] = row.count;
    }
    const dbSize = fs.statSync(AUTH_DB_PATH).size;
    const pageCount = db.pragma('page_count');
    const pageSize = db.pragma('page_size');
    return { tables: stats, dbSize, pageCount: pageCount[0]?.page_count, pageSize: pageSize[0]?.page_size, path: AUTH_DB_PATH };
  } finally { db.close(); }
}

function vacuumDb(auditCtx) {
  const db = openDb();
  try {
    db.exec('VACUUM');
    audit.log('receipt_scanner_authdb_vacuum', auditCtx);
  } finally { db.close(); }
}

// --- Users ---

function getUsers({ page = 1, pageSize = 20, search = '', activeOnly = false } = {}) {
  const db = openDb({ readonly: true });
  const c = cols();
  try {
    const offset = (page - 1) * pageSize;
    let where = '1=1';
    const params = [];
    if (search) {
      where += ' AND (email LIKE ? OR name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (activeOnly && c.userActive) { where += ' AND is_active = 1'; }
    const total = db.prepare(`SELECT COUNT(*) as count FROM users WHERE ${where}`).get(...params).count;

    const userCols = 'id, email, name, avatar_url, tier, prepaid_credits, created_at, updated_at, tier_updated_at'
      + (c.userActive ? ', is_active' : '')
      + (c.userLastLogin ? ', last_login_at' : '')
      + (c.userLoginCount ? ', login_count' : '')
      + (c.userVerified ? ', email_verified_at' : '');

    const rows = db.prepare(
      `SELECT ${userCols} FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    return { users: rows, total, page, pageSize };
  } finally { db.close(); }
}

function getUser(id) {
  const db = openDb({ readonly: true });
  const c = cols();
  try {
    const baseCols = 'id, email, name, avatar_url, tier, prepaid_credits, created_at, updated_at, tier_updated_at';
    const extraCols = (c.userActive ? ', is_active' : '')
      + (c.userLastLogin ? ', last_login_at' : '')
      + (c.userLoginCount ? ', login_count' : '')
      + (c.userVerified ? ', email_verified_at' : '');
    const user = db.prepare(`SELECT ${baseCols}${extraCols} FROM users WHERE id = ?`).get(id);
    if (!user) return null;
    const socialAccounts = db.prepare(
      'SELECT id, provider, provider_user_id, created_at FROM social_accounts WHERE user_id = ?'
    ).all(id);
    const tokenCount = db.prepare('SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = ?').get(id).count;
    const usageCount = db.prepare('SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ?').get(id).count;
    let receiptCount = 0;
    try { receiptCount = db.prepare('SELECT COUNT(*) as count FROM receipts WHERE user_id = ?').get(id).count; } catch {}
    return { ...user, socialAccounts, tokenCount, usageCount, receiptCount };
  } finally { db.close(); }
}

function createUser({ email, name, tier }, auditCtx) {
  const db = openDb();
  try {
    const id = uuidv4();
    db.prepare(
      'INSERT INTO users (id, email, name, tier) VALUES (?, ?, ?, ?)'
    ).run(id, email || null, name || null, tier || 'free');
    audit.log('receipt_scanner_user_create', { ...auditCtx, target: id, details: { email, name, tier } });
    return getUser(id);
  } finally { db.close(); }
}

function updateUser(id, { email, name, tier, avatar_url, prepaid_credits, is_active, login_count, last_login_at }, auditCtx) {
  const db = openDb();
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) throw new Error('User not found');

    const fields = [];
    const params = [];
    if (email !== undefined) { fields.push('email = ?'); params.push(email); }
    if (name !== undefined) { fields.push('name = ?'); params.push(name); }
    if (tier !== undefined) { fields.push('tier = ?, tier_updated_at = datetime(\'now\')'); params.push(tier); }
    if (avatar_url !== undefined) { fields.push('avatar_url = ?'); params.push(avatar_url); }
    if (prepaid_credits !== undefined) {
      const n = parseInt(prepaid_credits, 10);
      if (Number.isNaN(n) || n < 0) throw new Error('prepaid_credits must be a non-negative integer');
      fields.push('prepaid_credits = ?'); params.push(n);
    }
    if (is_active !== undefined) {
      const v = is_active ? 1 : 0;
      fields.push('is_active = ?'); params.push(v);
    }
    if (login_count !== undefined) {
      const n = parseInt(login_count, 10);
      if (Number.isNaN(n) || n < 0) throw new Error('login_count must be a non-negative integer');
      fields.push('login_count = ?'); params.push(n);
    }
    if (last_login_at !== undefined) { fields.push('last_login_at = ?'); params.push(last_login_at); }
    fields.push("updated_at = datetime('now')");

    params.push(id);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    audit.log('receipt_scanner_user_update', { ...auditCtx, target: id, details: { email, name, tier } });
    return getUser(id);
  } finally { db.close(); }
}

function deleteUser(id, auditCtx) {
  const db = openDb();
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM social_accounts WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM usage_logs WHERE user_id = ?').run(id);
      try { db.prepare('DELETE FROM receipts WHERE user_id = ?').run(id); } catch {}
      const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
      if (result.changes === 0) throw new Error('User not found');
    });
    tx();
    audit.log('receipt_scanner_user_delete', { ...auditCtx, target: id });
  } finally { db.close(); }
}

// --- Social Accounts ---

function unlinkSocialAccount(accountId, auditCtx) {
  const db = openDb();
  try {
    const result = db.prepare('DELETE FROM social_accounts WHERE id = ?').run(accountId);
    if (result.changes === 0) throw new Error('Social account not found');
    audit.log('receipt_scanner_social_unlink', { ...auditCtx, target: String(accountId) });
  } finally { db.close(); }
}

// --- Refresh Tokens ---

function getRefreshTokens({ page = 1, pageSize = 20, userId = null, includeRevoked = false } = {}) {
  const db = openDb({ readonly: true });
  try {
    const offset = (page - 1) * pageSize;
    let where = '1=1';
    const params = [];
    if (userId) { where += ' AND rt.user_id = ?'; params.push(userId); }
    if (!includeRevoked) { where += ' AND rt.revoked = 0'; }

    const total = db.prepare(`SELECT COUNT(*) as count FROM refresh_tokens rt WHERE ${where}`).get(...params).count;

    const rows = db.prepare(
      `SELECT rt.id, rt.user_id, u.email as user_email, rt.expires_at, rt.revoked, rt.created_at
       FROM refresh_tokens rt LEFT JOIN users u ON rt.user_id = u.id
       WHERE ${where} ORDER BY rt.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    return { tokens: rows, total, page, pageSize };
  } finally { db.close(); }
}

function revokeToken(tokenId, auditCtx) {
  const db = openDb();
  try {
    const result = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ? AND revoked = 0').run(tokenId);
    if (result.changes === 0) throw new Error('Token not found or already revoked');
    audit.log('receipt_scanner_token_revoke', { ...auditCtx, target: String(tokenId) });
  } finally { db.close(); }
}

function purgeExpiredTokens(auditCtx) {
  const db = openDb();
  try {
    const result = db.prepare(
      "DELETE FROM refresh_tokens WHERE expires_at < datetime('now') OR revoked = 1"
    ).run();
    audit.log('receipt_scanner_token_purge', { ...auditCtx, details: { deleted: result.changes } });
    return { deleted: result.changes };
  } finally { db.close(); }
}

// --- Usage Logs ---

function getUsageLogs({ page = 1, pageSize = 20, userId = null, action = null, search = null } = {}) {
  const db = openDb({ readonly: true });
  const c = cols();
  try {
    const offset = (page - 1) * pageSize;
    let where = '1=1';
    const params = [];
    if (userId) { where += ' AND ul.user_id = ?'; params.push(userId); }
    if (action) { where += ' AND ul.action = ?'; params.push(action); }
    if (search) {
      const term = `%${search}%`;
      if (c.usageDetails) {
        where += ' AND (u.email LIKE ? OR ul.ip_address LIKE ? OR ul.details LIKE ?)';
        params.push(term, term, term);
      } else {
        where += ' AND (u.email LIKE ? OR ul.ip_address LIKE ?)';
        params.push(term, term);
      }
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM usage_logs ul LEFT JOIN users u ON ul.user_id = u.id WHERE ${where}`).get(...params).count;

    const logCols = 'ul.id, ul.user_id, u.email as user_email, ul.ip_address, ul.action, ul.created_at'
      + (c.usageAgent ? ', ul.user_agent' : '')
      + (c.usageCredits ? ', ul.credits_used' : '')
      + (c.usageDetails ? ', ul.details' : '')
      + (c.usageDeviceId ? ', ul.device_id' : '');

    const rows = db.prepare(
      `SELECT ${logCols} FROM usage_logs ul LEFT JOIN users u ON ul.user_id = u.id
       WHERE ${where} ORDER BY ul.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    const actions = db.prepare('SELECT DISTINCT action FROM usage_logs ORDER BY action').all().map(r => r.action);

    return { logs: rows, total, page, pageSize, actions };
  } finally { db.close(); }
}

function purgeUsageLogs({ olderThanDays = 30 }, auditCtx) {
  const db = openDb();
  try {
    const result = db.prepare(
      "DELETE FROM usage_logs WHERE created_at < datetime('now', '-' || ? || ' days')"
    ).run(olderThanDays);
    audit.log('receipt_scanner_usage_purge', { ...auditCtx, details: { olderThanDays, deleted: result.changes } });
    return { deleted: result.changes };
  } finally { db.close(); }
}

// --- Receipts ---

function getReceipts({ page = 1, pageSize = 20, userId = null, search = null, model = null, status = null, category = null } = {}) {
  const db = openDb({ readonly: true });
  const c = cols();
  try {
    const offset = (page - 1) * pageSize;
    let where = '1=1';
    const params = [];
    if (userId) { where += ' AND r.user_id = ?'; params.push(userId); }
    if (search) {
      if (c.receiptMerchant) {
        where += ' AND (r.tags LIKE ? OR r.model_used LIKE ? OR r.merchant_name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      } else {
        where += ' AND (r.tags LIKE ? OR r.model_used LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
    }
    if (model) { where += ' AND r.model_used = ?'; params.push(model); }
    if (status && c.receiptStatus) { where += ' AND r.status = ?'; params.push(status); }
    if (category && c.receiptCategory) { where += ' AND r.category = ?'; params.push(category); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM receipts r WHERE ${where}`).get(...params).count;

    const receiptCols = 'r.id, r.user_id, u.email as user_email, u.name as user_name, '
      + 'r.model_used, r.processing_time_ms, r.scanned_at, r.updated_at, r.tags, '
      + 'r.image_thumbnail IS NOT NULL as has_thumbnail'
      + (c.receiptStatus ? ', r.status' : '')
      + (c.receiptError ? ', r.error_message' : '')
      + (c.receiptMerchant ? ', r.merchant_name' : '')
      + (c.receiptAmount ? ', r.total_amount' : '')
      + (c.receiptCurrency ? ', r.currency' : '')
      + (c.receiptFileSize ? ', r.file_size' : '')
      + (c.receiptCategory ? ', r.category' : '')
      + (c.receiptSource ? ', r.source' : '');

    const rows = db.prepare(
      `SELECT ${receiptCols} FROM receipts r LEFT JOIN users u ON r.user_id = u.id
       WHERE ${where} ORDER BY r.scanned_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    const models = db.prepare('SELECT DISTINCT model_used FROM receipts ORDER BY model_used').all().map(r => r.model_used);
    let statuses = [], categories = [];
    if (c.receiptStatus) {
      statuses = db.prepare('SELECT DISTINCT status FROM receipts ORDER BY status').all().map(r => r.status);
    }
    if (c.receiptCategory) {
      categories = db.prepare('SELECT DISTINCT category FROM receipts WHERE category IS NOT NULL ORDER BY category').all().map(r => r.category);
    }

    return { receipts: rows, total, page, pageSize, models, statuses, categories };
  } finally { db.close(); }
}

function getReceipt(id) {
  const db = openDb({ readonly: true });
  try {
    const receipt = db.prepare(
      'SELECT r.*, u.email as user_email, u.name as user_name FROM receipts r LEFT JOIN users u ON r.user_id = u.id WHERE r.id = ?'
    ).get(id);
    return receipt || null;
  } finally { db.close(); }
}

function updateReceipt(id, { tags, status, merchant_name, total_amount, currency, category, error_message, source }, auditCtx) {
  const db = openDb();
  try {
    const receipt = db.prepare('SELECT id FROM receipts WHERE id = ?').get(id);
    if (!receipt) throw new Error('Receipt not found');

    const fields = [];
    const params = [];
    if (tags !== undefined) { fields.push('tags = ?'); params.push(tags); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    if (merchant_name !== undefined) { fields.push('merchant_name = ?'); params.push(merchant_name); }
    if (total_amount !== undefined) { fields.push('total_amount = ?'); params.push(total_amount); }
    if (currency !== undefined) { fields.push('currency = ?'); params.push(currency); }
    if (category !== undefined) { fields.push('category = ?'); params.push(category); }
    if (error_message !== undefined) { fields.push('error_message = ?'); params.push(error_message); }
    if (source !== undefined) { fields.push('source = ?'); params.push(source); }
    fields.push("updated_at = datetime('now')");

    params.push(id);
    db.prepare(`UPDATE receipts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    audit.log('receipt_scanner_receipt_update', { ...auditCtx, target: id, details: { tags, status, category } });
    return getReceipt(id);
  } finally { db.close(); }
}

function deleteReceipt(id, auditCtx) {
  const db = openDb();
  try {
    const result = db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
    if (result.changes === 0) throw new Error('Receipt not found');
    audit.log('receipt_scanner_receipt_delete', { ...auditCtx, target: id });
  } finally { db.close(); }
}

module.exports = {
  getDbOverview, vacuumDb,
  getUsers, getUser, createUser, updateUser, deleteUser,
  unlinkSocialAccount,
  getRefreshTokens, revokeToken, purgeExpiredTokens,
  getUsageLogs, purgeUsageLogs,
  getReceipts, getReceipt, updateReceipt, deleteReceipt,
};
