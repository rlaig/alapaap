'use strict';

const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcrypt');
const database = require('../src/core/database');
const config = require('../config/default');

database.init(config.db.path);

const db = database.getDb();

function hashPassword(password) {
  return bcrypt.hashSync(password, config.auth.bcryptRounds);
}

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      const stdin = process.openStdin();
      const onData = (char) => {
        char = char.toString();
        if (char === '\n' || char === '\r') {
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          rl.close();
          resolve(rl._line || '');
          return;
        }
        if (char === '\u0003') process.exit();
        rl._line = (rl._line || '') + char;
        process.stdout.write('*');
      };
      process.stdin.setRawMode(true);
      stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const generate = args.includes('--generate');
  const positional = args.filter((a) => !a.startsWith('--'));
  const username = positional[0] || config.auth.defaultUsername;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) {
    console.error(`\n  Error: User "${username}" not found.\n`);
    database.close();
    process.exit(1);
  }

  console.log(`\n  Reset password for user: ${username}\n`);

  let password;

  if (generate) {
    password = crypto.randomBytes(16).toString('base64url');
  } else {
    password = await prompt('  New password: ', true);
    if (!password || password.length < 8) {
      console.error('\n  Error: Password must be at least 8 characters.\n');
      database.close();
      process.exit(1);
    }
    const confirm = await prompt('  Confirm password: ', true);
    if (password !== confirm) {
      console.error('\n  Error: Passwords do not match.\n');
      database.close();
      process.exit(1);
    }
  }

  const hash = hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.id);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  Password reset successfully                 ║');
  console.log(`  ║  username: ${username.padEnd(34)}║`);
  if (generate) {
    console.log(`  ║  password: ${password.padEnd(34)}║`);
  }
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  database.close();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  database.close();
  process.exit(1);
});
