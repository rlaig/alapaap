'use strict';

const { execFile, spawn } = require('child_process');
const config = require('../../config/default');

const SHELL_META = /[;&|`$><\n\r\\!{}()\[\]'"]/;

class CommandGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandGuardError';
  }
}

function validateArgs(args) {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new CommandGuardError(`Argument must be a string, got ${typeof arg}`);
    }
    if (SHELL_META.test(arg)) {
      throw new CommandGuardError(`Argument contains forbidden characters: ${arg}`);
    }
  }
}

function exec(binary, args = [], { timeout = 10000, maxBuffer = 1024 * 1024 } = {}) {
  const allowed = config.commandGuard.allowedBinaries;
  const fullPath = allowed[binary];

  if (!fullPath) {
    throw new CommandGuardError(`Binary not in allowlist: ${binary}`);
  }

  validateArgs(args);

  return new Promise((resolve, reject) => {
    execFile(fullPath, args, { timeout, maxBuffer, env: { PATH: '' } }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          return reject(new CommandGuardError(`Command timed out: ${binary}`));
        }
        return reject(new CommandGuardError(`Command failed (exit ${err.code}): ${stderr || err.message}`));
      }
      resolve(stdout);
    });
  });
}

function validateServiceName(name) {
  if (!name || typeof name !== 'string') {
    throw new CommandGuardError('Service name is required');
  }
  if (!config.commandGuard.serviceNamePattern.test(name)) {
    throw new CommandGuardError(`Invalid service name: ${name}`);
  }
  if (name.length > 256) {
    throw new CommandGuardError('Service name too long');
  }
}

function spawnBinary(binary, args = []) {
  const allowed = config.commandGuard.allowedBinaries;
  const fullPath = allowed[binary];

  if (!fullPath) {
    throw new CommandGuardError(`Binary not in allowlist: ${binary}`);
  }

  validateArgs(args);

  const child = spawn(fullPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '' },
  });

  return child;
}

module.exports = { exec, spawn: spawnBinary, validateServiceName, validateArgs, CommandGuardError };
