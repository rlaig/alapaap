'use strict';

const crypto = require('crypto');
const { createUser, userCount } = require('./user-model');
const config = require('../../../config/default');

function runFirstTimeSetup() {
  if (userCount() > 0) return;

  const password = crypto.randomBytes(16).toString('base64url');
  const user = createUser(config.auth.defaultUsername, password);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  FIRST RUN - Admin account created           ║');
  console.log(`  ║  username: ${user.username.padEnd(34)}║`);
  console.log(`  ║  password: ${password.padEnd(34)}║`);
  console.log('  ║                                              ║');
  console.log('  ║  Change this password after first login!     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
}

module.exports = { runFirstTimeSetup };
