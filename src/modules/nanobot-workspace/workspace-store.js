'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../../config/default');
const { getDb } = require('../../core/database');

const DEFAULT_PROTECTED_FILES = [
  'AGENTS.md',
  'HEARTBEAT.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'memory/MEMORY.md',
  'memory/history.jsonl',
  'cron/jobs.json',
  'config.json',
];

function wsCfg() {
  return config.nanobotWorkspace || {};
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getProtectedFiles() {
  const cfg = wsCfg();
  const custom = Array.isArray(cfg.protectedFiles) && cfg.protectedFiles.length > 0
    ? cfg.protectedFiles
    : DEFAULT_PROTECTED_FILES;
  return custom;
}

function getLockedDotDirs() {
  return wsCfg().lockedDotDirs || ['.git', '.nanobot', '.cursor'];
}

function isUnderLockedDotDir(relPath) {
  const parts = relPath.split(path.sep);
  const locked = getLockedDotDirs();
  return parts.some((p) => locked.includes(p));
}

function isProtectedFile(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  return getProtectedFiles().some((pf) => normalized === pf);
}

// In-memory cache for custom roots (loaded lazily from DB)
let customRootsCache = null;

function loadCustomRootsFromDb() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT source_key, workspace_root, git_root FROM workspace_custom_roots').all();
    const result = {};
    for (const row of rows) {
      result[row.source_key] = {
        workspaceRoot: row.workspace_root || null,
        gitRoot: row.git_root || null,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function getCustomRoots() {
  if (customRootsCache === null) {
    customRootsCache = loadCustomRootsFromDb();
  }
  return customRootsCache;
}

function getCustomRoot(sourceKey) {
  const roots = getCustomRoots();
  return roots[sourceKey] || { workspaceRoot: null, gitRoot: null };
}

function setCustomRoot(sourceKey, workspaceRoot, gitRoot) {
  // Validate paths if provided
  if (workspaceRoot != null) {
    workspaceRoot = workspaceRoot.trim();
    if (workspaceRoot !== '') {
      if (!path.isAbsolute(workspaceRoot)) {
        throw httpError(400, 'Workspace root must be an absolute path');
      }
      if (!fs.existsSync(workspaceRoot)) {
        throw httpError(400, 'Workspace root does not exist');
      }
      try {
        const stat = fs.statSync(workspaceRoot);
        if (!stat.isDirectory()) {
          throw httpError(400, 'Workspace root must be a directory');
        }
      } catch (e) {
        if (e.status) throw e;
        throw httpError(400, 'Cannot access workspace root path');
      }
    } else {
      workspaceRoot = null;
    }
  }

  if (gitRoot != null) {
    gitRoot = gitRoot.trim();
    if (gitRoot !== '') {
      if (!path.isAbsolute(gitRoot)) {
        throw httpError(400, 'Git root must be an absolute path');
      }
      if (!fs.existsSync(gitRoot)) {
        throw httpError(400, 'Git root does not exist');
      }
      try {
        const stat = fs.statSync(gitRoot);
        if (!stat.isDirectory()) {
          throw httpError(400, 'Git root must be a directory');
        }
      } catch (e) {
        if (e.status) throw e;
        throw httpError(400, 'Cannot access git root path');
      }
    } else {
      gitRoot = null;
    }
  }

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO workspace_custom_roots (source_key, workspace_root, git_root, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_key) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        git_root = excluded.git_root,
        updated_at = datetime('now')
    `).run(sourceKey, workspaceRoot, gitRoot);

    // Invalidate cache
    customRootsCache = null;
  } catch (err) {
    throw httpError(500, 'Failed to save custom root: ' + err.message);
  }
}

/**
 * Discover workspace sources from config (explicit + scanDirs).
 * Each source: { key, label, rootPath }
 */
function discoverWorkspaces() {
  const cfg = wsCfg();
  const explicit = cfg.sources && typeof cfg.sources === 'object' ? cfg.sources : {};
  const scanDirs = Array.isArray(cfg.scanDirs) ? cfg.scanDirs : [];
  const result = {};

  for (const [key, rootPath] of Object.entries(explicit)) {
    if (typeof rootPath === 'string' && rootPath.trim()) {
      const abs = rootPath.trim();
      if (path.isAbsolute(abs) && fs.existsSync(abs)) {
        result[key] = { key, label: key, rootPath: abs };
      }
    }
  }

  for (const dir of scanDirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = entry.name;
      if (result[key]) continue;
      const candidate = path.join(dir, key);
      const hasNanobotDir = fs.existsSync(path.join(candidate, '.nanobot'));
      const hasConfig = fs.existsSync(path.join(candidate, 'config.json'));
      const hasAgents = fs.existsSync(path.join(candidate, 'AGENTS.md'));
      if (hasNanobotDir || hasConfig || hasAgents) {
        result[key] = { key, label: key, rootPath: candidate };
      }
    }
  }

  return result;
}

function getSourceList() {
  const sources = discoverWorkspaces();
  return Object.values(sources).map((s) => {
    const custom = getCustomRoot(s.key);
    return {
      key: s.key,
      label: s.label,
      rootPath: s.rootPath,
      workspaceRoot: custom.workspaceRoot || s.rootPath,
      gitRoot: custom.gitRoot || null,
    };
  });
}

function resolveSource(sourceKey) {
  const sources = discoverWorkspaces();
  const keys = Object.keys(sources);
  const key = sourceKey || keys[0] || '';
  const src = sources[key];
  if (!src) {
    throw httpError(keys.length === 0 ? 503 : 404,
      keys.length === 0 ? 'No workspace sources configured' : `Unknown workspace source: ${key}`);
  }

  // Merge with custom roots from DB
  const custom = getCustomRoot(key);
  return {
    ...src,
    workspaceRoot: custom.workspaceRoot || src.rootPath,
    gitRoot: custom.gitRoot || null,
    // Track if these are custom overrides
    customWorkspaceRoot: custom.workspaceRoot || null,
    customGitRoot: custom.gitRoot || null,
  };
}

function safePath(rootPath, relPath) {
  if (!relPath) return rootPath;
  const cleaned = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.resolve(rootPath, cleaned);
  if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
    throw httpError(400, 'Path traversal denied');
  }
  const cfg = wsCfg();
  const bases = cfg.allowedBasePaths || [];
  if (bases.length > 0) {
    const ok = bases.some((base) => {
      const rb = path.resolve(base.trim());
      return resolved === rb || resolved.startsWith(rb + path.sep);
    });
    if (!ok) throw httpError(403, 'Path is not under an allowed base directory');
  }
  return resolved;
}

function relFromRoot(rootPath, absPath) {
  return path.relative(rootPath, absPath).split(path.sep).join('/');
}

function browseDir(rootPath, relPath) {
  const absDir = safePath(rootPath, relPath || '');
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'Directory not found');
    if (e.code === 'ENOTDIR') throw httpError(400, 'Not a directory');
    throw e;
  }

  const items = [];
  for (const entry of entries) {
    const rel = relFromRoot(rootPath, path.join(absDir, entry.name));
    const isDir = entry.isDirectory();
    const locked = isUnderLockedDotDir(rel);
    let stat = null;
    try {
      stat = fs.statSync(path.join(absDir, entry.name));
    } catch { /* skip stat errors */ }
    items.push({
      name: entry.name,
      path: rel,
      isDir,
      size: isDir ? null : (stat ? stat.size : null),
      modified: stat ? stat.mtime.toISOString() : null,
      protected: isProtectedFile(rel),
      locked,
    });
  }

  items.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return { path: relPath || '', items };
}

function readFile(rootPath, relPath) {
  if (!relPath) throw httpError(400, 'File path required');
  const absFile = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absFile);

  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'File not found');
    throw e;
  }
  if (stat.isDirectory()) throw httpError(400, 'Path is a directory, not a file');

  const maxSize = wsCfg().maxFileSizeBytes || 1048576;
  if (stat.size > maxSize) {
    throw httpError(413, `File too large (${stat.size} bytes, max ${maxSize})`);
  }

  const content = fs.readFileSync(absFile, 'utf8');
  return {
    path: rel,
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    protected: isProtectedFile(rel),
    locked: isUnderLockedDotDir(rel),
  };
}

function writeFile(rootPath, relPath, content) {
  if (!relPath) throw httpError(400, 'File path required');
  const absFile = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absFile);

  if (isUnderLockedDotDir(rel)) {
    throw httpError(403, 'Cannot write to locked directory');
  }

  const maxSize = wsCfg().maxFileSizeBytes || 1048576;
  const buf = Buffer.from(content || '', 'utf8');
  if (buf.length > maxSize) {
    throw httpError(413, `Content too large (${buf.length} bytes, max ${maxSize})`);
  }

  const dir = path.dirname(absFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absFile, content, 'utf8');
  const stat = fs.statSync(absFile);
  return {
    path: rel,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    protected: isProtectedFile(rel),
  };
}

function createFile(rootPath, relPath, content) {
  if (!relPath) throw httpError(400, 'File path required');
  const absFile = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absFile);

  if (isUnderLockedDotDir(rel)) {
    throw httpError(403, 'Cannot create files in locked directory');
  }

  if (fs.existsSync(absFile)) {
    throw httpError(409, 'File already exists');
  }

  return writeFile(rootPath, relPath, content || '');
}

function deleteFile(rootPath, relPath) {
  if (!relPath) throw httpError(400, 'File path required');
  const absFile = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absFile);

  if (isUnderLockedDotDir(rel)) {
    throw httpError(403, 'Cannot delete files in locked directory');
  }
  if (isProtectedFile(rel)) {
    throw httpError(403, `Cannot delete protected file: ${rel}`);
  }

  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'File not found');
    throw e;
  }

  if (stat.isDirectory()) {
    let entries;
    try { entries = fs.readdirSync(absFile); } catch { entries = []; }
    if (entries.length > 0) {
      throw httpError(400, 'Directory is not empty');
    }
    fs.rmdirSync(absFile);
  } else {
    fs.unlinkSync(absFile);
  }

  return { path: rel };
}

function deleteDirectory(rootPath, relPath) {
  if (!relPath) throw httpError(400, 'Directory path required');
  const absDir = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absDir);

  if (isUnderLockedDotDir(rel)) {
    throw httpError(403, 'Cannot delete locked directory');
  }

  let stat;
  try {
    stat = fs.statSync(absDir);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'Directory not found');
    throw e;
  }

  if (!stat.isDirectory()) {
    throw httpError(400, 'Path is not a directory');
  }

  fs.rmSync(absDir, { recursive: true, force: true });
  return { path: rel };
}

function mkdir(rootPath, relPath) {
  if (!relPath) throw httpError(400, 'Directory path required');
  const absDir = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absDir);

  if (isUnderLockedDotDir(rel)) {
    throw httpError(403, 'Cannot create directories in locked directory');
  }

  if (fs.existsSync(absDir)) {
    throw httpError(409, 'Path already exists');
  }

  fs.mkdirSync(absDir, { recursive: true });
  return { path: rel };
}

function rename(rootPath, oldRelPath, newRelPath) {
  if (!oldRelPath) throw httpError(400, 'oldPath required');
  if (!newRelPath) throw httpError(400, 'newPath required');

  const absOld = safePath(rootPath, oldRelPath);
  const absNew = safePath(rootPath, newRelPath);
  const relOld = relFromRoot(rootPath, absOld);
  const relNew = relFromRoot(rootPath, absNew);

  if (isUnderLockedDotDir(relOld) || isUnderLockedDotDir(relNew)) {
    throw httpError(403, 'Cannot rename files in/to locked directory');
  }
  if (isProtectedFile(relOld)) {
    throw httpError(403, `Cannot rename protected file: ${relOld}`);
  }

  if (!fs.existsSync(absOld)) {
    throw httpError(404, 'Source path not found');
  }
  if (fs.existsSync(absNew)) {
    throw httpError(409, 'Destination already exists');
  }

  const destDir = path.dirname(absNew);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.renameSync(absOld, absNew);
  return { oldPath: relOld, newPath: relNew };
}

function resolveFilePath(rootPath, relPath) {
  if (!relPath) throw httpError(400, 'File path required');
  const absFile = safePath(rootPath, relPath);
  const rel = relFromRoot(rootPath, absFile);

  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'File not found');
    throw e;
  }
  if (stat.isDirectory()) throw httpError(400, 'Path is a directory, not a file');

  return {
    absPath: absFile,
    path: rel,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    protected: isProtectedFile(rel),
    locked: isUnderLockedDotDir(rel),
  };
}

module.exports = {
  discoverWorkspaces,
  getSourceList,
  resolveSource,
  browseDir,
  readFile,
  writeFile,
  createFile,
  deleteFile,
  deleteDirectory,
  mkdir,
  rename,
  resolveFilePath,
  isProtectedFile,
  isUnderLockedDotDir,
  getProtectedFiles,
  getCustomRoot,
  setCustomRoot,
};
