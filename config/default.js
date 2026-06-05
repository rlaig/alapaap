'use strict';

const path = require('path');

function parseTrustProxy() {
  const v = process.env.ALAPAAP_TRUST_PROXY;
  if (!v) return false;
  if (v === 'true' || v === '1') return 1;
  const n = parseInt(v, 10);
  return !Number.isNaN(n) && n > 0 ? n : false;
}

module.exports = {
  port: parseInt(process.env.ALAPAAP_PORT, 10) || 3000,
  host: process.env.ALAPAAP_HOST || '0.0.0.0',

  /** When true, set `Secure` on session cookie (use behind HTTPS). */
  cookieSecure: process.env.ALAPAAP_COOKIE_SECURE === '1' || process.env.ALAPAAP_COOKIE_SECURE === 'true',

  /** Express `trust proxy` (hop count). Set when behind nginx/caddy so req.ip and rate limits are correct. */
  trustProxy: parseTrustProxy(),

  db: {
    path: process.env.ALAPAAP_DB_PATH || path.join(__dirname, '..', 'data', 'alapaap.db'),
  },

  auth: {
    jwtExpiry: process.env.ALAPAAP_JWT_EXPIRY || '8h',
    bcryptRounds: 12,
    cookieName: 'alapaap_token',
    defaultUsername: 'admin',
  },

  ws: {
    systemMetricsInterval: 2000,
    servicesInterval: 5000,
    dockerInterval: 5000,
    clickhouseInterval: 5000,
    nanobotServiceInterval: 5000,
    tradingBotInterval: 5000,
    receiptScannerLogsInterval: 5000,
    /** Close WebSocket if client never completes auth (reduces idle connection abuse). */
    authTimeoutMs: parseInt(process.env.ALAPAAP_WS_AUTH_TIMEOUT_MS, 10) || 30000,
  },

  modules: {
    enabled: [
      'auth',
      'system-monitor',
      'services-manager',
      'docker-manager',
      'clickhouse-manager',
      'network-check',
      'nanobot-cron',
      'nanobot-clickhouse-logs',
      'nanobot-service',
      'nanobot-workspace',
      'trading-bot',
      'backtest',
      'navidrome-music',
      'receipt-scanner-logs',
    ],
  },

  commandGuard: {
    allowedBinaries: {
      systemctl: '/usr/bin/systemctl',
      journalctl: '/usr/bin/journalctl',
      df: '/usr/bin/df',
      tone: '/usr/local/bin/tone',
    },
    allowedSystemctlSubcommands: ['list-units', 'show', 'start', 'stop', 'restart', 'status'],
    serviceNamePattern: /^[a-zA-Z0-9_@:.-]+$/,
    maxLogLines: 500,
  },

  clickhouse: {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT, 10) || 8123,
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    queryTimeout: 30000,
    maxResultLimit: 1000,
    /** Retention / cleanup (see clickhouse-manager retention routes). */
    retention: {
      denyDatabases: ['system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables'],
      /** If non-empty, only these DBs may use retention APIs (in addition to deny list). */
      allowedDatabases: (process.env.ALAPAAP_CH_RETENTION_ALLOWED_DBS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxAlterDeleteRows: parseInt(process.env.ALAPAAP_CH_MAX_ALTER_DELETE_ROWS, 10) || 50_000_000,
      maxPartitionsPerRequest: parseInt(process.env.ALAPAAP_CH_MAX_DROP_PARTITIONS, 10) || 500,
      mutationTimeoutMs: parseInt(process.env.ALAPAAP_CH_MUTATION_TIMEOUT_MS, 10) || 120000,
    },
    /** Automated housekeeping (see clickhouse-manager maintenance submodule). */
    maintenance: {
      enabled: process.env.ALAPAAP_CH_MAINTENANCE_ENABLED !== '0',
      intervalMs: parseInt(process.env.ALAPAAP_CH_MAINTENANCE_INTERVAL_MS, 10) || 86400000,
      systemLogTTLDays: parseInt(process.env.ALAPAAP_CH_SYS_LOG_TTL_DAYS, 10) || 7,
      maxInactivePartsPerTable: parseInt(process.env.ALAPAAP_CH_MAX_INACTIVE_PARTS, 10) || 500,
      maxPartsPerTable: parseInt(process.env.ALAPAAP_CH_MAX_PARTS_PER_TABLE, 10) || 3000,
      staleMutationMinutes: parseInt(process.env.ALAPAAP_CH_STALE_MUTATION_MINS, 10) || 120,
    },
  },

  docker: {
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  },

  networkCheck: {
    allowPublicTargets: process.env.ALAPAAP_NETWORK_ALLOW_PUBLIC === '1',
    defaultTcpTimeoutMs: 3000,
    maxTcpTimeoutMs: 15000,
    maxBatchPorts: 32,
  },

  /** Nanobot cron editor – multi-source. See .env for configuration. */
  nanobotCron: {
    sources: (() => {
      try { return JSON.parse(process.env.ALAPAAP_NANOBOT_CRON_SOURCES || '{}'); } catch { return {}; }
    })(),
    scanDirs: (process.env.ALAPAAP_NANOBOT_CRON_SCAN_DIRS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedBasePaths: (process.env.ALAPAAP_NANOBOT_CRON_ALLOWED_BASES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  tradingBot: {
    basePath: process.env.ALAPAAP_TRADING_BOT_PATH || '/home/ubuntu/fleetnano/trader0/trading-bot',
    serviceName: 'trading-bot',
    serviceUser: 'ubuntu',
    maxLogLines: 500,
    ckDatabase: process.env.ALAPAAP_TRADING_BOT_CK_DB || 'trading',
  },

  nanobotService: {
    nanobotBin: process.env.ALAPAAP_NANOBOT_BIN || '/home/ubuntu/.local/bin/nanobot',
    configDir: process.env.ALAPAAP_NANOBOT_CONFIG_DIR || '/home/ubuntu/.nanobot',
    maxLogLines: 500,
  },

  /** Navidrome music file browser and tag editor. */
  navidromeMusic: {
    musicPath: process.env.ALAPAAP_NAVIDROME_MUSIC_PATH || '/path/navidrome/music',
    toneBin: process.env.ALAPAAP_TONE_BIN || '/usr/local/bin/tone',
    supportedExtensions: ['mp3', 'm4a', 'flac', 'ogg', 'wav', 'opus', 'wma', 'aac'],
    maxTagWritesPerRequest: 50,
  },

  /** Nanobot workspace file manager – multi-source, mirrors nanobot-cron discovery. */
  nanobotWorkspace: {
    sources: (() => {
      try { return JSON.parse(process.env.ALAPAAP_NANOBOT_WORKSPACE_SOURCES || '{}'); } catch { return {}; }
    })(),
    scanDirs: (process.env.ALAPAAP_NANOBOT_WORKSPACE_SCAN_DIRS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedBasePaths: (process.env.ALAPAAP_NANOBOT_WORKSPACE_ALLOWED_BASES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    protectedFiles: (process.env.ALAPAAP_NANOBOT_WORKSPACE_PROTECTED_FILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    lockedDotDirs: ['.git', '.nanobot', '.cursor'],
    maxFileSizeBytes: parseInt(process.env.ALAPAAP_NANOBOT_WORKSPACE_MAX_FILE_SIZE, 10) || 1048576,
  },

  /** Nanobot ClickHouse log viewer for OPENROUTER_TRACES. */
  nanobotClickhouseLogs: {
    database: process.env.ALAPAAP_NANOBOT_CH_DB || 'default',
    table: process.env.ALAPAAP_NANOBOT_CH_TABLE || 'OPENROUTER_TRACES',
    maxPageSize: 200,
    defaultPageSize: 50,
    searchableColumns: (process.env.ALAPAAP_NANOBOT_CH_SEARCH_COLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** Receipt scanner log viewer. */
  receiptScannerLogs: {
    services: ['receipt-scanner.service', 'auth-service.service'],
    authDbPath: process.env.ALAPAAP_RECEIPT_AUTH_DB
      || '/home/ubuntu/.nanobot/workspace/projects/e95/receipt-scanner/backend/auth/auth.db',
    defaultLines: 200,
  },
};
