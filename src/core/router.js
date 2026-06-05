'use strict';

const express = require('express');
const os = require('os');

function createRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: os.uptime(),
      timestamp: new Date().toISOString(),
      version: require('../../package.json').version,
    });
  });

  return router;
}

module.exports = { createRouter };
