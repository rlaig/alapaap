'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXEC_TIMEOUT = 5000;
const MAX_DIFF_BYTES = 50 * 1024;

function isGitRepo(rootPath) {
  const dotGit = path.join(rootPath, '.git');
  if (fs.existsSync(dotGit)) return true;
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function getBranch(rootPath) {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return out.trim() || 'HEAD';
  } catch {
    return null;
  }
}

const STATUS_MAP = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  '?': 'untracked',
  '!': 'ignored',
};

function parseStatusLine(line) {
  if (!line || line.length < 4) return null;
  const x = line[0];
  const y = line[1];
  let filePath = line.slice(3);

  let oldPath = null;
  const arrowIdx = filePath.indexOf(' -> ');
  if (arrowIdx !== -1) {
    oldPath = filePath.slice(0, arrowIdx);
    filePath = filePath.slice(arrowIdx + 4);
  }

  const entries = [];

  if (x !== ' ' && x !== '?') {
    entries.push({
      path: filePath,
      oldPath,
      status: STATUS_MAP[x] || 'modified',
      staged: true,
    });
  }

  if (y !== ' ' && y !== '?') {
    entries.push({
      path: filePath,
      oldPath,
      status: STATUS_MAP[y] || 'modified',
      staged: false,
    });
  }

  if (x === '?' && y === '?') {
    entries.push({
      path: filePath,
      oldPath: null,
      status: 'untracked',
      staged: false,
    });
  }

  return entries;
}

function getStatus(rootPath) {
  if (!isGitRepo(rootPath)) {
    return { isGitRepo: false, branch: null, files: [] };
  }

  const branch = getBranch(rootPath);
  let output;
  try {
    output = execSync('git status --porcelain=v1', {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return { isGitRepo: true, branch, files: [] };
  }

  const files = [];
  const lines = output.split('\n');
  for (const line of lines) {
    if (!line) continue;
    const entries = parseStatusLine(line);
    if (entries) files.push(...entries);
  }

  return { isGitRepo: true, branch, files };
}

function getDiff(rootPath, filePath, staged) {
  if (!isGitRepo(rootPath)) {
    return { path: filePath, diff: '', error: 'Not a git repository' };
  }

  const resolved = path.resolve(rootPath, filePath);
  if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
    return { path: filePath, diff: '', error: 'Path traversal denied' };
  }

  const args = staged ? ['git', 'diff', '--cached'] : ['git', 'diff'];
  args.push('--');
  args.push(filePath);

  try {
    const output = execSync(args.join(' '), {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    const diff = output.length > MAX_DIFF_BYTES
      ? output.slice(0, MAX_DIFF_BYTES) + '\n\n... diff truncated (too large) ...\n'
      : output;

    return { path: filePath, diff };
  } catch (e) {
    if (e.stdout) {
      const diff = e.stdout.length > MAX_DIFF_BYTES
        ? e.stdout.slice(0, MAX_DIFF_BYTES) + '\n\n... diff truncated (too large) ...\n'
        : e.stdout;
      return { path: filePath, diff };
    }
    return { path: filePath, diff: '', error: 'Failed to get diff' };
  }
}

function getNewFileDiff(rootPath, filePath) {
  const absPath = path.resolve(rootPath, filePath);
  if (!absPath.startsWith(rootPath + path.sep) && absPath !== rootPath) {
    return { path: filePath, diff: '', error: 'Path traversal denied' };
  }

  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    let diff = `diff --git a/${filePath} b/${filePath}\n`;
    diff += `new file\n`;
    diff += `--- /dev/null\n`;
    diff += `+++ b/${filePath}\n`;
    diff += `@@ -0,0 +1,${lines.length} @@\n`;

    const truncated = lines.slice(0, 500);
    diff += truncated.map((l) => '+' + l).join('\n');
    if (lines.length > 500) {
      diff += '\n\n... file truncated (too many lines) ...\n';
    }

    if (diff.length > MAX_DIFF_BYTES) {
      diff = diff.slice(0, MAX_DIFF_BYTES) + '\n\n... diff truncated (too large) ...\n';
    }

    return { path: filePath, diff };
  } catch {
    return { path: filePath, diff: '', error: 'Failed to read file' };
  }
}

module.exports = {
  isGitRepo,
  getBranch,
  getStatus,
  getDiff,
  getNewFileDiff,
};
