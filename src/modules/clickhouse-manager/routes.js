'use strict';

const express = require('express');
const router = express.Router();
const ch = require('./clickhouse');
const retention = require('./retention');
const maintenance = require('./maintenance');
const audit = require('../../core/audit-log');

router.get('/status', async (req, res, next) => {
  try {
    const info = await ch.getServerInfo();
    res.json(info);
  } catch (err) { next(err); }
});

router.get('/databases', async (req, res, next) => {
  try {
    const dbs = await ch.getDatabases();
    res.json(dbs);
  } catch (err) { next(err); }
});

router.get('/databases/:db/tables', async (req, res, next) => {
  try {
    const tables = await ch.getTables(req.params.db);
    res.json(tables);
  } catch (err) {
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/databases/:db/tables/:table', async (req, res, next) => {
  try {
    const info = await ch.getTableInfo(req.params.db, req.params.table);
    res.json(info);
  } catch (err) {
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/query', async (req, res, next) => {
  try {
    const { sql } = req.body || {};
    if (!sql) return res.status(400).json({ error: 'SQL query required' });

    audit.log('clickhouse_query', {
      userId: req.user?.id,
      target: sql.slice(0, 200),
      ip: req.ip,
    });

    const result = await ch.query(sql);
    res.json(result);
  } catch (err) {
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/metrics', async (req, res, next) => {
  try {
    const metrics = await ch.getMetrics();
    res.json(metrics);
  } catch (err) { next(err); }
});

router.get('/query-log', async (req, res, next) => {
  try {
    const limit = req.query.limit || 50;
    const log = await ch.getQueryLog(limit);
    res.json(log);
  } catch (err) { next(err); }
});

router.get('/storage/overview', async (req, res, next) => {
  try {
    const result = await retention.getStorageOverview();
    res.json(result);
  } catch (err) {
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/storage/:db/:table', async (req, res, next) => {
  try {
    const meta = await retention.getRetentionTableMeta(req.params.db, req.params.table);
    res.json(meta);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/storage/preview', async (req, res, next) => {
  try {
    const { database, table, column, olderThanDays } = req.body || {};
    if (!database || !table || !column || olderThanDays == null) {
      return res.status(400).json({ error: 'database, table, column, and olderThanDays required' });
    }
    const preview = await retention.previewRetention({
      database,
      table,
      column,
      olderThanDays,
    });
    audit.log('clickhouse_retention_preview', {
      userId: req.user?.id,
      target: `${database}.${table}`,
      ip: req.ip,
      details: { olderThanDays, column },
    });
    res.json(preview);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.post('/storage/execute', async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = await retention.executeRetention(body);
    audit.log('clickhouse_retention_execute', {
      userId: req.user?.id,
      target: `${body.database}.${body.table}`,
      ip: req.ip,
      details: {
        action: body.action,
        olderThanDays: body.olderThanDays,
        partitionCount: Array.isArray(body.partitions) ? body.partitions.length : 0,
        column: body.column,
      },
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

router.get('/maintenance/status', async (req, res, next) => {
  try {
    res.json(maintenance.getStatus());
  } catch (err) { next(err); }
});

router.post('/maintenance/run', async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    audit.log('clickhouse_maintenance_run', {
      userId: req.user?.id,
      ip: req.ip,
      details: { force },
    });
    const result = await maintenance.runMaintenanceCycle(force);
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/maintenance/diagnostics', async (req, res, next) => {
  try {
    const diag = await maintenance.getDiagnostics();
    res.json(diag);
  } catch (err) { next(err); }
});

router.post('/maintenance/cache/flush', async (req, res, next) => {
  try {
    audit.log('clickhouse_cache_flush', {
      userId: req.user?.id,
      ip: req.ip,
    });
    const result = await maintenance.flushCaches();
    res.json({ ok: true, results: result });
  } catch (err) { next(err); }
});

router.post('/maintenance/mutations/kill', async (req, res, next) => {
  try {
    const { database, table, mutationId } = req.body || {};
    if (!database || !table || !mutationId) {
      return res.status(400).json({ error: 'database, table, and mutationId required' });
    }
    audit.log('clickhouse_kill_mutation', {
      userId: req.user?.id,
      ip: req.ip,
      details: { database, table, mutationId },
    });
    const result = await maintenance.killMutation(database, table, mutationId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
