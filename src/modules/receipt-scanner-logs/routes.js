'use strict';

const express = require('express');
const router = express.Router();
const { getServiceStatuses, getLogs, getUsageStats } = require('./service');
const deploy = require('./deploy');
const authDb = require('./auth-db');
const audit = require('../../core/audit-log');

const auditCtx = (req) => ({ userId: req.user?.id, ip: req.ip });

// --- Existing routes (service status, logs, usage) ---

router.get('/status', async (req, res, next) => {
  try {
    const services = await getServiceStatuses();
    res.json({ services });
  } catch (err) {
    if (err.name === 'CommandGuardError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/logs', async (req, res, next) => {
  try {
    const result = await getLogs({
      lines: req.query.lines || 200,
      service: req.query.service || null,
      level: req.query.level || null,
      search: req.query.search || null,
      since: req.query.since || null,
    });
    res.json(result);
  } catch (err) {
    if (err.name === 'CommandGuardError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/usage', async (req, res, next) => {
  try {
    const stats = getUsageStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// --- Deploy ---

router.post('/deploy', (req, res, next) => {
  try {
    const { target } = req.body || {};
    const t = target || 'all';
    const result = deploy.executeDeploy(t);
    audit.log('deploy_start', {
      userId: req.user?.id,
      target: t,
      ip: req.ip,
    });
    res.json(result);
  } catch (err) {
    if (err.code === 409) return res.status(409).json({ error: err.message });
    if (err.code === 400) return res.status(400).json({ error: err.message });
    if (err.code === 500) return res.status(500).json({ error: err.message });
    next(err);
  }
});

router.get('/deploy/status', (req, res) => {
  res.json(deploy.getStatus());
});

// --- Auth DB management ---

router.get('/auth-db/overview', (req, res, next) => {
  try {
    res.json(authDb.getDbOverview());
  } catch (err) { next(err); }
});

router.post('/auth-db/vacuum', (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'VACUUM') return res.status(400).json({ error: 'Type VACUUM to confirm' });
    authDb.vacuumDb(auditCtx(req));
    const overview = authDb.getDbOverview();
    res.json({ ok: true, dbSize: overview.dbSize });
  } catch (err) { next(err); }
});

// Users

router.get('/auth-db/users', (req, res, next) => {
  try {
    res.json(authDb.getUsers({
      page: parseInt(req.query.page) || 1,
      pageSize: Math.min(parseInt(req.query.pageSize) || 20, 100),
      search: req.query.search || '',
      activeOnly: req.query.activeOnly === '1',
    }));
  } catch (err) { next(err); }
});

router.post('/auth-db/users', (req, res, next) => {
  try {
    const { email, name, tier } = req.body || {};
    const user = authDb.createUser({ email, name, tier }, auditCtx(req));
    res.json(user);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }
    next(err);
  }
});

router.get('/auth-db/users/:id', (req, res, next) => {
  try {
    const user = authDb.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { next(err); }
});

router.patch('/auth-db/users/:id', (req, res, next) => {
  try {
    const { email, name, tier, avatar_url, prepaid_credits, is_active, login_count, last_login_at, subscription_id, subscription_status, subscription_product, customer_id, lifetime_tier } = req.body || {};
    const user = authDb.updateUser(req.params.id, { email, name, tier, avatar_url, prepaid_credits, is_active, login_count, last_login_at, subscription_id, subscription_status, subscription_product, customer_id, lifetime_tier }, auditCtx(req));
    res.json(user);
  } catch (err) {
    if (err.message === 'User not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.delete('/auth-db/users/:id', (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE USER') return res.status(400).json({ error: 'Type DELETE USER to confirm' });
    authDb.deleteUser(req.params.id, auditCtx(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'User not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

// Social Accounts

router.delete('/auth-db/social-accounts/:id', (req, res, next) => {
  try {
    authDb.unlinkSocialAccount(req.params.id, auditCtx(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Social account not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

// Tokens

router.get('/auth-db/tokens', (req, res, next) => {
  try {
    res.json(authDb.getRefreshTokens({
      page: parseInt(req.query.page) || 1,
      pageSize: Math.min(parseInt(req.query.pageSize) || 20, 100),
      userId: req.query.userId || null,
      includeRevoked: req.query.includeRevoked === '1',
    }));
  } catch (err) { next(err); }
});

router.post('/auth-db/tokens/:id/revoke', (req, res, next) => {
  try {
    authDb.revokeToken(req.params.id, auditCtx(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Token not found or already revoked') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/auth-db/tokens/purge', (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'PURGE') return res.status(400).json({ error: 'Type PURGE to confirm' });
    const result = authDb.purgeExpiredTokens(auditCtx(req));
    res.json(result);
  } catch (err) { next(err); }
});

// Usage Logs

router.get('/auth-db/usage-logs', (req, res, next) => {
  try {
    res.json(authDb.getUsageLogs({
      page: parseInt(req.query.page) || 1,
      pageSize: Math.min(parseInt(req.query.pageSize) || 20, 100),
      userId: req.query.userId || null,
      action: req.query.action || null,
      search: req.query.search || null,
    }));
  } catch (err) { next(err); }
});

router.post('/auth-db/usage-logs/purge', (req, res, next) => {
  try {
    const { confirm, olderThanDays } = req.body || {};
    if (confirm !== 'PURGE') return res.status(400).json({ error: 'Type PURGE to confirm' });
    const days = Math.max(1, parseInt(olderThanDays) || 30);
    const result = authDb.purgeUsageLogs({ olderThanDays: days }, auditCtx(req));
    res.json(result);
  } catch (err) { next(err); }
});

// Receipts

router.get('/auth-db/receipts', (req, res, next) => {
  try {
    res.json(authDb.getReceipts({
      page: parseInt(req.query.page) || 1,
      pageSize: Math.min(parseInt(req.query.pageSize) || 20, 100),
      userId: req.query.userId || null,
      search: req.query.search || null,
      model: req.query.model || null,
      status: req.query.status || null,
      category: req.query.category || null,
    }));
  } catch (err) { next(err); }
});

router.get('/auth-db/receipts/:id', (req, res, next) => {
  try {
    const receipt = authDb.getReceipt(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (err) { next(err); }
});

router.patch('/auth-db/receipts/:id', (req, res, next) => {
  try {
    const { tags, status, merchant_name, total_amount, currency, category, error_message, source } = req.body || {};
    const receipt = authDb.updateReceipt(req.params.id, { tags, status, merchant_name, total_amount, currency, category, error_message, source }, auditCtx(req));
    res.json(receipt);
  } catch (err) {
    if (err.message === 'Receipt not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.delete('/auth-db/receipts/:id', (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE RECEIPT') return res.status(400).json({ error: 'Type DELETE RECEIPT to confirm' });
    authDb.deleteReceipt(req.params.id, auditCtx(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Receipt not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

// Payment Events

router.get('/auth-db/payments', (req, res, next) => {
  try {
    res.json(authDb.getPaymentEvents({
      page: parseInt(req.query.page) || 1,
      pageSize: Math.min(parseInt(req.query.pageSize) || 20, 100),
      userId: req.query.userId || null,
      eventType: req.query.eventType || null,
      status: req.query.status || null,
    }));
  } catch (err) { next(err); }
});

router.get('/auth-db/payments/:id', (req, res, next) => {
  try {
    const event = authDb.getPaymentEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Payment event not found' });
    res.json(event);
  } catch (err) { next(err); }
});

router.delete('/auth-db/payments/:id', (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE EVENT') return res.status(400).json({ error: 'Type DELETE EVENT to confirm' });
    authDb.deletePaymentEvent(req.params.id, auditCtx(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Payment event not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.post('/auth-db/payments/purge', (req, res, next) => {
  try {
    const { confirm, olderThanDays } = req.body || {};
    if (confirm !== 'PURGE') return res.status(400).json({ error: 'Type PURGE to confirm' });
    const days = Math.max(1, parseInt(olderThanDays) || 90);
    const result = authDb.purgePaymentEvents({ olderThanDays: days }, auditCtx(req));
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
