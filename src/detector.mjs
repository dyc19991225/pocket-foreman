import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IS_WIN = process.platform === 'win32';

const WORKER_CANDIDATES = {
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    bins: IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'],
    extraWinDirs: [
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), '.volta', 'bin'),
    ],
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code CLI',
    bins: IS_WIN ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'],
    extraWinDirs: [
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), '.local', 'bin'),
    ],
  },
  agy: {
    id: 'agy',
    displayName: 'Google Antigravity CLI',
    bins: IS_WIN ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'],
    extraWinDirs: [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity', 'bin'),
      path.join(os.homedir(), '.gemini', 'antigravity', 'bin'),
    ],
  },
};

function resolveExecutable(spec) {
  // 1. Probe system PATH via where.exe / which
  const locator = IS_WIN ? 'where.exe' : 'which';
  for (const b of spec.bins) {
    try {
      const out = execFileSync(locator, [b], {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (out.length > 0 && fs.existsSync(out[0])) {
        return out[0];
      }
    } catch {
      // ignore
    }
  }

  // 2. Fallback common user-level install dirs on Windows
  if (IS_WIN) {
    for (const dir of spec.extraWinDirs) {
      for (const b of spec.bins) {
        const candidate = path.join(dir, b);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function probeVersion(exePath) {
  if (!exePath) return null;
  try {
    const cmd = IS_WIN && exePath.toLowerCase().endsWith('.cmd') ? 'cmd.exe' : exePath;
    const args = cmd === 'cmd.exe' ? ['/d', '/s', '/c', `"${exePath}" --version`] : ['--version'];
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 3500,
      windowsVerbatimArguments: cmd === 'cmd.exe',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out.split(/\r?\n/)[0]?.slice(0, 80) || 'installed';
  } catch {
    return 'installed';
  }
}

let cachedReport = null;

export function detectWorkers(forceRefresh = false) {
  if (cachedReport && !forceRefresh) return cachedReport;
  const result = {};
  for (const [key, spec] of Object.entries(WORKER_CANDIDATES)) {
    const exe = resolveExecutable(spec);
    result[key] = {
      id: key,
      displayName: spec.displayName,
      installed: Boolean(exe),
      executable: exe,
      version: exe ? probeVersion(exe) : null,
    };
  }
  cachedReport = result;
  return result;
}
