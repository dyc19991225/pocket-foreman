import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.foreman',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'target',
  'backup',
  'backups',
  'runs',
  'hermes-home',
  'VRoidStudio_Data',
  'blender.crt',
  'blender.shared',
  '5.3',
  'D3D12',
  'license',
  'AdsPower Global',
  'WeMeet',
  '.arts',
  '.codeartsdoer',
]);

function readQuickGitBranch(dir) {
  const headPath = path.join(dir, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  try {
    const raw = fs.readFileSync(headPath, 'utf8').trim();
    if (raw.startsWith('ref: refs/heads/')) return raw.slice('ref: refs/heads/'.length);
    return raw.slice(0, 7);
  } catch {
    return 'HEAD';
  }
}

function detectProjectMeta(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const hasGit = entries.some((e) => (e.isDirectory() || e.isFile()) && e.name === '.git');

  let kind = null;
  let suggestedVerifyCmd = '';

  if (files.has('package.json')) {
    kind = 'node';
    try {
      const rawPkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
      const pkg = JSON.parse(rawPkg);
      const s = pkg.scripts || {};
      if (s.test && s.build && !String(s.test).includes('no test specified')) {
        suggestedVerifyCmd = 'npm test && npm run build';
      } else if (s.build) {
        suggestedVerifyCmd = 'npm run build';
      } else if (s.test && !String(s.test).includes('no test specified')) {
        suggestedVerifyCmd = 'npm test';
      }
    } catch {
      // ignore malformed package.json
    }
  } else if (files.has('pyproject.toml') || files.has('requirements.txt')) {
    kind = 'python';
  } else if (files.has('Cargo.toml')) {
    kind = 'rust';
    suggestedVerifyCmd = 'cargo check';
  } else if (files.has('go.mod')) {
    kind = 'go';
    suggestedVerifyCmd = 'go test ./...';
  } else if (files.has('project.godot')) {
    kind = 'godot';
  } else if (hasGit) {
    kind = 'git';
  }

  if (!kind) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    // ignore
  }

  return {
    name: path.basename(dir),
    path: dir,
    kind,
    isGit: hasGit,
    branch: hasGit ? readQuickGitBranch(dir) : null,
    suggestedVerifyCmd,
    updatedAt: mtimeMs ? new Date(mtimeMs).toISOString().slice(0, 10) : '',
    mtimeMs,
  };
}

/**
 * Scans workspace root directories (up to depth 2) to auto-discover local coding repositories.
 */
export function scanWorkspaceProjects(roots) {
  const found = [];
  const seen = new Set();

  function walk(dir, depth) {
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (depth > 2 || seen.has(key)) return;
    seen.add(key);

    if (depth > 0) {
      const meta = detectProjectMeta(resolved);
      if (meta) {
        found.push(meta);
        return; // Don't recurse inside a discovered project
      }
    }

    let entries;
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || ent.name.startsWith('$') || ent.name.startsWith('_')) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(resolved, ent.name), depth + 1);
    }
  }

  for (const r of roots) {
    if (r && fs.existsSync(r)) walk(r, 0);
  }

  // Also include roots themselves if they are projects
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    const resolved = path.resolve(r);
    const meta = detectProjectMeta(resolved);
    if (meta && !found.some((f) => f.path.toLowerCase() === resolved.toLowerCase())) {
      found.push(meta);
    }
  }

  found.sort((a, b) => (b.isGit ? 1 : 0) - (a.isGit ? 1 : 0) || b.mtimeMs - a.mtimeMs);
  return found;
}
