'use strict';

const { exec: guardExec, validateServiceName, CommandGuardError } = require('../../core/command-guard');
const config = require('../../../config/default');

const ALLOWED_ACTIONS = new Set(config.commandGuard.allowedSystemctlSubcommands);

async function listServices() {
  const output = await guardExec('systemctl', [
    'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend',
  ]);

  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      unit: parts[0] || '',
      load: parts[1] || '',
      active: parts[2] || '',
      sub: parts[3] || '',
      description: parts.slice(4).join(' '),
    };
  });
}

async function getStatus(name) {
  validateServiceName(name);
  const output = await guardExec('systemctl', ['show', name, '--no-pager']);
  const props = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      props[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return props;
}

async function controlService(name, action) {
  validateServiceName(name);
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new CommandGuardError(`Action not allowed: ${action}`);
  }
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new CommandGuardError(`Control action not allowed: ${action}`);
  }
  return guardExec('systemctl', [action, name]);
}

async function getLogs(name, lines = 50) {
  validateServiceName(name);
  const n = Math.max(1, Math.min(parseInt(lines, 10) || 50, config.commandGuard.maxLogLines));
  return guardExec('journalctl', ['-u', name, '-n', String(n), '--no-pager']);
}

module.exports = { listServices, getStatus, controlService, getLogs };
