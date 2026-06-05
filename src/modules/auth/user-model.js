'use strict';

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../core/database');
const config = require('../../../config/default');

function createUser(username, password) {
  const db = getDb();
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, config.auth.bcryptRounds);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(id, username, hash, 'admin');
  return { id, username, role: 'admin' };
}

function findByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findById(id) {
  return getDb().prepare('SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?').get(id);
}

function verifyPassword(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  const valid = bcrypt.compareSync(password, user.password_hash);
  return valid ? { id: user.id, username: user.username, role: user.role } : null;
}

function changePassword(userId, oldPassword, newPassword) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  const valid = bcrypt.compareSync(oldPassword, user.password_hash);
  if (!valid) throw new Error('Current password is incorrect');

  const hash = bcrypt.hashSync(newPassword, config.auth.bcryptRounds);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
}

function userCount() {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM users').get();
  return row.cnt;
}

module.exports = { createUser, findByUsername, findById, verifyPassword, changePassword, userCount };
