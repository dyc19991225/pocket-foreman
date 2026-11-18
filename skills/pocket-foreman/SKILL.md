---
name: pocket-foreman
description: Orchestrate parallel coding tasks across local OpenAI Codex, Claude Code, and Google Antigravity CLIs using isolated git worktrees, live token/USD ledger accounting, Arena Race comparisons, and mobile/Telegram approval cards. Activate when fanning out subtasks across multiple coding CLIs, comparing solutions side-by-side, or managing background coding queues.
---

# pocket-foreman — Multi-CLI Worktree Orchestrator Skill

Use `pocket-foreman` to dispatch background coding tasks or run parallel **Arena Races** across locally authenticated `codex`, `claude`, and `agy` CLIs without file collisions.

## Interactive Guided Entry (Codex-Style Onboarding)

When invoked broadly via `$pocket-foreman`, offer 3 concise choices:
1. **(Recommended) Launch Mission Control & Mobile Deck** — Start `npx pocket-foreman up` (`http://127.0.0.1:4788/` + LAN `/mobile` approval card deck).
2. **Run a Parallel Worktree Arena Race** — Dispatch the same tricky feature/bug across `codex,claude,agy` in isolated `foreman/*` git worktrees to compare speed, USD cost, and `git diff` before merging the winner.
3. **Inspect CLI Readiness & Spend Ledger** — Run `pocket-foreman doctor` and `pocket-foreman ledger`.

## Core CLI Commands

```bash
# 1. Detect installed & authenticated local CLIs (Codex / Claude Code / Antigravity)
npx pocket-foreman doctor

# 2. Start Web Mission Control + LAN Mobile Approval Deck
npx pocket-foreman up --port 4788

# 3. Dispatch a single isolated git-worktree write task
npx pocket-foreman submit "Add sliding-window rate limiter + unit tests" --worker codex --write

# 4. Run a 3-way parallel Arena Race across Codex, Claude Code, and Antigravity
npx pocket-foreman submit "Refactor auth middleware to eliminate race condition" --race codex,claude,agy --write

# 5. View token & USD spend breakdown from .foreman/ledger.jsonl
npx pocket-foreman ledger
```

## Safety & Isolation Contract

- **Write tasks never touch the main working tree directly.** Each write task checks out `foreman/<TASK-ID>` inside `.foreman/worktrees/<TASK-ID>`, runs sandboxed, captures `git diff`, and pauses in `awaiting_approval` until a human clicks **Approve & Merge** (on Desktop or `/mobile` / Telegram card).
- **Read-only tasks** enforce `--sandbox read-only` (`codex`), `--tools Read,Glob,Grep` (`claude`), or `--sandbox` (`agy`).
