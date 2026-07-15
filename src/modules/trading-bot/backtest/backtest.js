'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = require('../../../../config/default');

function cfg() {
  return config.tradingBot || {};
}

function basePath() {
  return cfg().basePath || '/home/ubuntu/fleetnano/trader0/trading-bot';
}

function backtestDir() {
  return path.join(basePath(), 'data', 'backtests');
}

function historicalDir() {
  return path.join(basePath(), 'data', 'historical');
}

function manifestPath() {
  return path.join(historicalDir(), 'manifest.json');
}

function serviceUser() {
  return cfg().serviceUser || 'ubuntu';
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitizeRunName(name) {
  return name.replace(/[^a-zA-Z0-9_.\-+()]/g, '');
}

// Spawn a python command as the configured service user
function pythonBin() {
  return cfg().pythonBin || 'python3.11';
}

function spawnAsUser(args, cwd) {
  const user = serviceUser();
  const pyCmd = args.join(' ');
  const wrapped = `cd ${cwd} && ${pyCmd}`;
  return spawn('/usr/bin/su', ['-', user, '-c', wrapped], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── Strategies ──

const STRATEGIES = [
  {
    name: 'simple_sma',
    label: 'Simple SMA',
    params: [
      { key: 'fast_period', type: 'int', default: 10, description: 'Fast SMA period' },
      { key: 'slow_period', type: 'int', default: 30, description: 'Slow SMA period' },
    ],
  },
  {
    name: 'ema',
    label: 'EMA Crossover',
    params: [
      { key: 'fast_period', type: 'int', default: 8, description: 'Fast EMA period' },
      { key: 'slow_period', type: 'int', default: 21, description: 'Slow EMA period' },
    ],
  },
  {
    name: 'rsi',
    label: 'RSI',
    params: [
      { key: 'period', type: 'int', default: 14, description: 'RSI period' },
      { key: 'oversold', type: 'int', default: 30, description: 'Oversold threshold' },
      { key: 'overbought', type: 'int', default: 70, description: 'Overbought threshold' },
    ],
  },
  {
    name: 'macd',
    label: 'MACD',
    params: [
      { key: 'fast', type: 'int', default: 12, description: 'Fast period' },
      { key: 'slow', type: 'int', default: 26, description: 'Slow period' },
      { key: 'signal_period', type: 'int', default: 9, description: 'Signal period' },
    ],
  },
  {
    name: 'bollinger',
    label: 'Bollinger Bands',
    params: [
      { key: 'period', type: 'int', default: 20, description: 'BB period' },
      { key: 'num_std', type: 'float', default: 2.0, description: 'Std deviations' },
    ],
  },
  {
    name: 'vwap',
    label: 'VWAP',
    params: [
      { key: 'std_bands', type: 'float', default: 1.0, description: 'Std band width' },
    ],
  },
  {
    name: 'glucksmann',
    label: 'Glucksmann BB',
    params: [
      { key: 'bb_period', type: 'int', default: 20, description: 'BB period' },
      { key: 'bb_std', type: 'float', default: 2.0, description: 'BB std deviations' },
      { key: 'vol_fast', type: 'int', default: 10, description: 'Volume fast period' },
      { key: 'vol_slow', type: 'int', default: 50, description: 'Volume slow period' },
      { key: 'vli_fast_period', type: 'int', default: 10, description: 'VLI fast smoothing period' },
      { key: 'vli_slow_period', type: 'int', default: 50, description: 'VLI slow smoothing / std window' },
    ],
  },
  {
    name: 'momentum_breakout',
    label: 'Momentum Breakout',
    params: [
      { key: 'stoch_period', type: 'int', default: 14, description: 'Stochastic RSI period' },
      { key: 'stoch_k', type: 'int', default: 3, description: 'K smoothing' },
      { key: 'stoch_d', type: 'int', default: 3, description: 'D smoothing' },
      { key: 'roc_period', type: 'int', default: 9, description: 'Rate-of-change period' },
      { key: 'bb_period', type: 'int', default: 20, description: 'BB period' },
      { key: 'bb_std', type: 'float', default: 2.0, description: 'BB std deviations' },
      { key: 'volume_surge_mult', type: 'float', default: 1.5, description: 'Volume surge multiplier' },
      { key: 'oversold', type: 'float', default: 20.0, description: 'Stoch RSI oversold' },
      { key: 'overbought', type: 'float', default: 80.0, description: 'Stoch RSI overbought' },
    ],
  },
  {
    name: 'rsi_divergence',
    label: 'RSI Divergence',
    params: [
      { key: 'rsi_period', type: 'int', default: 14, description: 'RSI period' },
      { key: 'lookback', type: 'int', default: 5, description: 'Swing detection lookback' },
      { key: 'min_divergence', type: 'float', default: 1.0, description: 'Min RSI swing separation' },
    ],
  },
  {
    name: 'volatility_squeeze',
    label: 'Volatility Squeeze',
    params: [
      { key: 'bb_period', type: 'int', default: 20, description: 'BB period' },
      { key: 'bb_std', type: 'float', default: 2.0, description: 'BB std deviations' },
      { key: 'kc_period', type: 'int', default: 20, description: 'Keltner EMA period' },
      { key: 'kc_atr_mult', type: 'float', default: 1.5, description: 'Keltner ATR multiplier' },
      { key: 'adx_period', type: 'int', default: 14, description: 'ADX period' },
      { key: 'squeeze_lookback', type: 'int', default: 6, description: 'Bars to check for squeeze' },
      { key: 'volume_surge_mult', type: 'float', default: 1.3, description: 'Volume surge multiplier' },
    ],
  },
  {
    name: 'composite',
    label: 'Composite Voting',
    isEnsemble: true,
    params: [
      { key: 'min_agree', type: 'int', default: 2, description: 'Min agreeing sub-strategies' },
      { key: 'min_strength', type: 'float', default: 0.3, description: 'Min average signal strength' },
    ],
    subStrategies: ['ema', 'rsi', 'macd', 'bollinger', 'vwap', 'glucksmann', 'simple_sma', 'momentum_breakout', 'rsi_divergence', 'volatility_squeeze'],
    defaultSubs: [
      { name: 'ema' },
      { name: 'rsi' },
      { name: 'macd' },
    ],
  },
  {
    name: 'mix',
    label: 'Mix Ensemble',
    isEnsemble: true,
    blendModes: ['weighted', 'regime', 'best', 'layered', 'adaptive', 'aggressive'],
    params: [
      { key: 'blend_mode', type: 'select', options: ['weighted', 'regime', 'best', 'layered', 'adaptive', 'aggressive'], default: 'weighted', description: 'Blend algorithm' },
      { key: 'threshold', type: 'float', default: 0.3, description: 'Signal threshold (0-1)' },
      { key: 'adapt_window', type: 'int', default: 30, description: 'Adaptive rolling window' },
    ],
    subStrategies: ['ema', 'rsi', 'macd', 'bollinger', 'vwap', 'glucksmann', 'simple_sma', 'momentum_breakout', 'rsi_divergence', 'volatility_squeeze'],
    defaultSubs: [
      { name: 'ema', weight: 0.4 },
      { name: 'rsi', weight: 0.3 },
      { name: 'macd', weight: 0.3 },
    ],
  },
];

const ALL_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];

function getAvailableStrategies() {
  return STRATEGIES;
}

// ── Profiles ──

function profilesDir() {
  return path.join(basePath(), 'config', 'profiles');
}

function getAvailableProfiles() {
  const dir = profilesDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  return files.map((f) => {
    const name = f.replace(/\.yaml$/, '');
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const doc = yaml.load(raw) || {};
      const strat = doc.strategy || {};
      const sl = doc.stop_loss || {};
      const risk = doc.risk || {};
      const dyn = doc.dynamic_sizing || {};
      const mtf = doc.multi_timeframe || {};
      const tsw = doc.tiered_stopwin || {};
      const sf = doc.signal_filter || {};
      const cd = doc.cooldown || {};
      return {
        name,
        config: {
          strategy: strat,
          signal_filter: sf,
          stop_loss: sl,
          dynamic_sizing: dyn,
          multi_timeframe: mtf,
          cooldown: cd,
          tiered_stopwin: tsw,
          risk,
        },
      };
    } catch {
      return { name, config: {} };
    }
  });
}

// ── Historical Data ──

function getHistoricalDataInfo() {
  const manifest = readJsonFile(manifestPath()) || {};
  const result = [];
  for (const tf of ALL_TIMEFRAMES) {
    const info = manifest[tf];
    if (!info) {
      result.push({ timeframe: tf, available: false });
      continue;
    }
    let fileSize = null;
    try {
      const stat = fs.statSync(path.join(historicalDir(), `BTCUSDT_${tf}.parquet`));
      fileSize = stat.size;
    } catch { /* ignore */ }
    result.push({
      timeframe: tf,
      available: true,
      rows: info.rows || 0,
      minTs: info.min_ts || null,
      maxTs: info.max_ts || null,
      updatedAt: info.updated_at || null,
      lastDownloadMonth: info.last_download_month || null,
      lastCcxtFill: info.last_ccxt_fill || null,
      fileSize,
    });
  }
  return result;
}

function spawnDownloadHistorical(timeframes, startMonth) {
  const args = [
    pythonBin(), path.join(basePath(), 'src', 'fetch_history.py'),
    'download', '--timeframes', timeframes, '--start', startMonth,
  ];
  return spawnAsUser(args, basePath());
}

function spawnUpdateHistorical(timeframes) {
  const args = [
    pythonBin(), path.join(basePath(), 'src', 'fetch_history.py'),
    'update', '--timeframes', timeframes,
  ];
  return spawnAsUser(args, basePath());
}

// ── Backtest Runs ──

function listRuns() {
  const dir = backtestDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metricsPath = path.join(dir, entry.name, 'metrics.json');
    const metrics = readJsonFile(metricsPath);
    if (!metrics) continue;
    let mtime = 0;
    try { mtime = fs.statSync(metricsPath).mtimeMs; } catch { /* ignore */ }
    runs.push({ name: entry.name, metrics, mtime });
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs.map(({ name, metrics }) => ({ name, metrics }));
}

function getRunMetrics(runName) {
  const safe = sanitizeRunName(runName);
  return readJsonFile(path.join(backtestDir(), safe, 'metrics.json'));
}

function getRunTrades(runName) {
  const safe = sanitizeRunName(runName);
  return readJsonFile(path.join(backtestDir(), safe, 'trades.json')) || [];
}

function getRunEquity(runName) {
  const safe = sanitizeRunName(runName);
  const csvPath = path.join(backtestDir(), safe, 'equity.csv');
  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        const v = vals[j];
        row[headers[j]] = isNaN(v) ? v : Number(v);
      }
      rows.push(row);
    }
    // Downsample to max 500 points for the UI
    if (rows.length > 500) {
      const step = Math.ceil(rows.length / 500);
      const sampled = [];
      for (let i = 0; i < rows.length; i += step) sampled.push(rows[i]);
      if (sampled[sampled.length - 1] !== rows[rows.length - 1]) sampled.push(rows[rows.length - 1]);
      return sampled;
    }
    return rows;
  } catch {
    return [];
  }
}

function getRunReport(runName) {
  const safe = sanitizeRunName(runName);
  const reportPath = path.join(backtestDir(), safe, 'report.txt');
  try {
    return fs.readFileSync(reportPath, 'utf8');
  } catch {
    return null;
  }
}

function deleteRun(runName) {
  const safe = sanitizeRunName(runName);
  const runDir = path.join(backtestDir(), safe);
  if (!fs.existsSync(runDir)) return false;
  fs.rmSync(runDir, { recursive: true, force: true });
  return true;
}

function compareRuns(runNames) {
  const results = [];
  for (const name of runNames) {
    const metrics = getRunMetrics(name);
    if (metrics) results.push({ name, metrics });
  }
  return results;
}

function spawnBacktest(params) {
  const args = [
    pythonBin(), path.join(basePath(), 'src', 'backtest.py'),
    '--strategy', params.strategy,
    '--timeframe', params.timeframe || '15m',
    '--start', params.start,
    '--end', params.end,
    '--capital', String(params.capital || 10000),
  ];
  if (params.profile) {
    args.push('--profile', params.profile);
  }
  if (params.params && typeof params.params === 'object') {
    for (const [k, v] of Object.entries(params.params)) {
      args.push('--param', `${k}=${v}`);
    }
  }
  return spawnAsUser(args, basePath());
}

module.exports = {
  getAvailableStrategies,
  getAvailableProfiles,
  getHistoricalDataInfo,
  spawnDownloadHistorical,
  spawnUpdateHistorical,
  listRuns,
  getRunMetrics,
  getRunTrades,
  getRunEquity,
  getRunReport,
  deleteRun,
  compareRuns,
  spawnBacktest,
  ALL_TIMEFRAMES,
};
