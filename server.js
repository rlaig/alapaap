'use strict';

const http = require('http');
const express = require('express');
const path = require('path');
const config = require('./config/default');
const database = require('./src/core/database');
const { requireAuth } = require('./src/core/auth');
const websocket = require('./src/core/websocket');
const { createRouter } = require('./src/core/router');
const { loadModules, destroyAll } = require('./src/core/module-loader');
const { securityHeaders, csrfProtection, requestLogger } = require('./src/core/security');
const { rateLimit } = require('./src/core/rate-limit');

database.init(config.db.path);
console.log('[db] Database initialized');

const app = express();
const server = http.createServer(app);

if (config.trustProxy) {
  app.set('trust proxy', config.trustProxy);
}

app.use(securityHeaders);
app.use(requestLogger);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(csrfProtection);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth/login', rateLimit({
  windowMs: 60000,
  max: 5,
  keyFn: (req) => `login:${req.ip}`,
  message: 'Too many login attempts, try again in a minute',
}));

app.use(requireAuth);

const apiRouter = createRouter();
app.use('/api', apiRouter);

const wss = websocket.init(server);
console.log('[ws] WebSocket server initialized');

loadModules(app, wss, config);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : (err.message || 'Error');
  if (status === 500) console.error('[error]', err.stack || err.message);
  res.status(status).json({ error: message });
});

server.listen(config.port, config.host, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║         ALAPAAP DASHBOARD             ║`);
  console.log(`  ║   http://${config.host}:${config.port}                ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});

async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, cleaning up...`);
  websocket.closeAll();
  await destroyAll();
  database.close();
  server.close(() => {
    console.log('[shutdown] Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
