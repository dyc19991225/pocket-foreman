import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function isGitRepository(dir) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true';
  } catch {
    return false;
  }
}

export function getRepoRoot(dir) {
  return git(['rev-parse', '--show-toplevel'], dir);
}

/**
 * Safely unlinks a zero-copy node_modules directory junction/symlink inside a worktree
 * WITHOUT touching the parent repository's actual node_modules folder!
 */
export function unlinkWorktreeNodeModules(wtPath) {
  const nmPath = path.join(wtPath, 'node_modules');
  try {
    const st = fs.lstatSync(nmPath);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(nmPath);
    }
  } catch {
    // doesn't exist or not a symlink
  }
}

/**
 * Creates an isolated git worktree + branch `foreman/<taskId>` and links `node_modules` via
 * zero-copy OS junction so `npm run build` / `tsc` works immediately in 0ms!
 */
export function createIsolatedWorktree(repoDir, worktreesBaseDir, taskId) {
  const root = getRepoRoot(repoDir);
  const safeId = taskId.replace(/[^A-Za-z0-9_-]/g, '-');
  const branchName = `foreman/${safeId}`;
  const wtPath = path.join(worktreesBaseDir, safeId);

  if (fs.existsSync(wtPath)) {
    unlinkWorktreeNodeModules(wtPath);
    try {
      git(['worktree', 'remove', '--force', wtPath], root);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }
  try {
    git(['branch', '-D', branchName], root);
  } catch {
    // branch didn't exist yet
  }

  git(['worktree', 'add', '-b', branchName, wtPath, 'HEAD'], root);

  // Zero-copy link node_modules if present in repoRoot so Autoloop build/test runs instantly!
  const rootNm = path.join(root, 'node_modules');
  const wtNm = path.join(wtPath, 'node_modules');
  if (fs.existsSync(rootNm) && !fs.existsSync(wtNm)) {
    try {
      fs.symlinkSync(rootNm, wtNm, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // non-fatal if symlink unavailable
    }
  }

  return { repoRoot: root, branchName, worktreePath: wtPath };
}

/**
 * Captures changed files + unified diff inside a workspace or worktree (including untracked files).
 */
export function inspectWorkspaceDiff(workDir) {
  if (!isGitRepository(workDir)) {
    return { changedFiles: [], diffStat: '', diffPatch: '' };
  }
  try {
    const statusLines = git(['status', '--porcelain'], workDir)
      .split(/\r?\n/)
      .filter((l) => Boolean(l) && !l.includes('node_modules'));
    const changedFiles = statusLines.map((l) => l.trim());
    const diffStat = git(['diff', '--stat', 'HEAD'], workDir);
    let diffPatch = git(['diff', 'HEAD'], workDir);

    for (const line of statusLines) {
      if (line.startsWith('?? ')) {
        const rel = line.slice(3).trim();
        const full = path.join(workDir, rel);
        if (fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size < 24000) {
          const body = fs.readFileSync(full, 'utf8');
          const plusBody = body
            .split(/\r?\n/)
            .slice(0, 60)
            .map((ln) => `+${ln}`)
            .join('\n');
          diffPatch += `\n--- /dev/null\n+++ b/${rel}\n${plusBody}\n`;
        }
      }
    }

    return {
      changedFiles,
      diffStat,
      diffPatch: diffPatch.slice(0, 32000),
    };
  } catch {
    return { changedFiles: [], diffStat: '', diffPatch: '' };
  }
}

export function approveAndMergeWorktree(task) {
  if (!task.worktreePath || !task.repoRoot || !fs.existsSync(task.worktreePath)) {
    return { merged: false, reason: 'Task did not run in an isolated git worktree.' };
  }
  const wt = task.worktreePath;
  const root = task.repoRoot;

  unlinkWorktreeNodeModules(wt);
  git(['add', '-A'], wt);
  const porcelain = git(['status', '--porcelain'], wt);
  if (porcelain) {
    git(
      [
        '-c',
        'user.name=Pocket Foreman',
        '-c',
        'user.email=foreman@local',
        'commit',
        '-m',
        `feat(${task.id}): ${task.goal.slice(0, 72)} [worker:${task.worker}]`,
      ],
      wt
    );
  }

  const commitSha = git(['rev-parse', '--short', 'HEAD'], wt);
  git(['merge', '--no-ff', task.branchName, '-m', `Merge ${task.branchName} (${task.worker})`], root);

  try {
    git(['worktree', 'remove', '--force', wt], root);
    git(['branch', '-d', task.branchName], root);
  } catch {
    // non-fatal cleanup warning
  }

  return { merged: true, commitSha };
}

export function discardWorktree(task) {
  if (!task.worktreePath || !task.repoRoot) return { discarded: false };
  unlinkWorktreeNodeModules(task.worktreePath);
  try {
    git(['worktree', 'remove', '--force', task.worktreePath], task.repoRoot);
  } catch {
    fs.rmSync(task.worktreePath, { recursive: true, force: true });
  }
  try {
    git(['branch', '-D', task.branchName], task.repoRoot);
  } catch {
    // ignore
  }
  return { discarded: true };
}
