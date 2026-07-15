'use strict';

/**
 * Thin re-export of ClickHouse connection helpers from clickhouse-manager.
 * Keeps the dependency explicit so this module works even if clickhouse-manager
 * is loaded in a different order.
 */

const config = require('../../../config/default');

const DB_NAME_RE = /^[a-zA-Z0-9_]+$/;

class QueryValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'QueryValidationError'; }
}

function validateDbName(name) {
  if (!name || !DB_NAME_RE.test(name)) {
    throw new QueryValidationError(`Invalid database/table name: ${name}`);
  }
}

function chUrl(path = '') {
  return `http://${config.clickhouse.host}:${config.clickhouse.port}${path}`;
}

function chAuthHeaders() {
  const user = config.clickhouse.user || 'default';
  const password = config.clickhouse.password || '';
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
  };
}

module.exports = { chUrl, chAuthHeaders, validateDbName, QueryValidationError };
