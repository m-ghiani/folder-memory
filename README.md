# advanced-memory

A plugin for **Claude Code and Codex** that turns your project's memory files (`CLAUDE.md` / `AGENTS.md`) into a **lookup index over the codebase**.

Instead of grepping and globbing the whole repository on every request, Claude walks a small, curated index:

```
root CLAUDE.md  →  <folder>/CLAUDE.md  →  the 1–2 files that matter
```

A hook keeps the index's structure in sync with the filesystem. The bundled `memory-indexer` skill teaches Claude to read the index first and to write entries that are easy to match.

## Why it's useful

Without an index, Claude finds code by searching. In a large repo, a question like "where do we apply invoice discounts?" turns into repo-wide `Grep` calls, broad `Glob` patterns, and reads of files that only look relevant: UI copy that mentions "discount", tests, fixtures. That costs tokens, time, and context window, and noisy matches can send Claude down the wrong path.

With advanced-memory:

- **Fewer tokens, less noise.** Claude reads two short memory files and opens only the file it needs, not every match.
- **Deterministic navigation.** The same request takes the same route through the index on every session.
- **Local knowledge travels with the code.** Each folder's `CLAUDE.md` records what its files do, the main symbols they export, and local state such as "pagination not implemented yet". Claude Code also loads these files automatically when it works in that folder.
- **Self-healing.** When the index misses, Claude falls back to a scoped search and then fixes the entry that should have routed it there.
- **Zero maintenance for structure.** New, moved, and deleted folders are detected automatically. You never edit the index by hand unless you want to.

## How it works

### The index

**Root `CLAUDE.md`** holds a managed block with one line per top-level folder: why the folder exists, plus the routing keys a request would mention.

```markdown
<!-- dir-index:start -->
## Directory
**Lookup protocol (mandatory, before any Grep/Glob):** this index and each folder's `CLAUDE.md` map the codebase. Match the request to a folder below, `Read` its `CLAUDE.md`, follow **Sottocartelle** down, open only the files it names. Search with Grep/Glob only when the index has no match, scoped to the closest folder.

- `api/`: HTTP API (users, orders, JWT auth, Express)
- `billing/`: invoices and payments (discounts, VAT, totals)
- `web/`: React storefront (catalog, cart, checkout UI)
<!-- dir-index:end -->
```

The `Lookup protocol` line is written by the hook. Because the root `CLAUDE.md` is always in Claude's context, the rule applies to every request, not only when the skill triggers.

**`<folder>/CLAUDE.md`** is the folder memory: the purpose of the folder, its key files with their main symbols, subfolders, and current local state.

```markdown
# billing

**Scopo**: invoice computation.

## File
- `invoice.ts`: invoice total (`invoiceTotal`), applies discounts (`applyDiscount`)
- `vat.ts`: VAT rates (`vatRate`)
- `*.test.ts`: unit tests

## Stato
- `invoice.ts`: multi-currency rounding still missing

<!-- memory-indexer:managed -->
```

> Section names (`Scopo`, `File`, `Sottocartelle`, `Stato`, `Note`) are fixed: the hook parses them. The *content* is written in your project's dominant language, or the one you set in the configuration.

### The lookup

For a request that touches code, Claude:

1. Matches the request against the root index and picks one or two candidate folders.
2. Reads the folder's `CLAUDE.md` and descends through **Sottocartelle** if needed.
3. Opens only the files the memory names.
4. On a miss, searches with `Grep`/`Glob` scoped to the candidate folder first, and the whole repo last.
5. Repairs the index: adds the missing keyword or symbol to the entry that should have matched.

Claude skips the lookup when you name exact paths, or when the task doesn't involve the codebase.

### The hooks

| Hook | What it does |
|---|---|
| `SessionStart` | Syncs structure. Reports pending stubs, `_TODO` index lines, and memories whose files changed long after the memory was written |
| `PostToolUse` (Bash, Write) | Silently creates stubs for new folders, updates the root index, and fixes the `# path` header of moved memories |
| `Stop` | Blocks once per session item when memory needs filling, is stale (files added or removed), or is over budget, so Claude updates it before finishing |

The hooks own **structure**. The skill owns **content**. Hook writes go through the filesystem, never through a Claude tool call, so they can't trigger themselves in a loop.

### What Claude is allowed to edit

- Files containing `<!-- memory-indexer:stub -->`: replaced entirely when filled.
- Files ending with `<!-- memory-indexer:managed -->`: surgical, line-level edits only.
- The root block between `<!-- dir-index:start -->` and `<!-- dir-index:end -->`.

Any other `CLAUDE.md` is considered hand-written and is never modified. Claude still reads it during lookups.

## Installation

Requirements: Claude Code or Codex CLI, and Node.js 18 or later.

### Claude Code

```bash
git clone https://github.com/m-ghiani/folder-memory.git advanced-memory
claude --plugin-dir /path/to/advanced-memory
```

### Codex

The repository is also a Codex plugin (`.codex-plugin/plugin.json`) and a one-plugin marketplace (`.agents/plugins/marketplace.json`). The skill and the hooks are shared with Claude Code.

```bash
codex plugin marketplace add /path/to/advanced-memory   # or: m-ghiani/folder-memory
codex plugin add advanced-memory@folder-memory
```

Codex asks you to trust the plugin's hooks the first time they run (`/hooks` in the TUI).

Under Codex the plugin works the same way, with these differences:

| | Claude Code | Codex |
|---|---|---|
| Memory file | `CLAUDE.md` | `AGENTS.md` (the file Codex loads on its own) |
| State and settings | `.claude/` | `.codex/` |
| Project root | `$CLAUDE_PROJECT_DIR` | nearest folder with `.git` above the session cwd |
| `PostToolUse` | `Bash`, `Write` | `Bash`, `apply_patch` |

The host is detected from the hook input (Codex adds `turn_id`); `--host=claude|codex` forces it.

### Projects used with both agents

By default each agent keeps its own file, so a project used with both would get `CLAUDE.md` and `AGENTS.md` side by side. Pick one with `memory_file` (same value in `.claude/` and `.codex/` settings, or one settings file: each agent also reads the other's):

- `memory_file: AGENTS.md`, and put `@AGENTS.md` in the root `CLAUDE.md` so Claude Code loads the index; or
- `memory_file: CLAUDE.md`, and set `project_doc_fallback_filenames = ["CLAUDE.md"]` in `~/.codex/config.toml` so Codex loads it (only where no `AGENTS.md` exists).

### First run on an existing project

The first hook run records only a baseline: existing folders are not stubbed automatically. To create a stub in every existing folder:

```bash
node /path/to/advanced-memory/scripts/dir-sync.mjs --mode=backfill --root /path/to/project
```

Then ask Claude to fill them (see the examples below). The `Stop` hook also reminds Claude about pending stubs as you work.

## Usage examples

**Ask a question about the code.** No special syntax is needed. Lookup happens automatically.

```
> Which file applies the discount to an invoice total?
```

Typical tool trace:

```
Read  src/CLAUDE.md
Read  src/billing/CLAUDE.md
Grep  "applyDiscount"  path=src/billing      ← scoped confirmation only
→ src/billing/invoice.ts
```

**Create a new folder.** The hook stubs it, and Claude fills its memory before ending the turn.

```
> Add a src/notifications module with an email sender and an SMS sender.
```

Result: `src/notifications/CLAUDE.md` is created and filled, and the `notifications/` line in the root index gets a real description instead of `_TODO`.

**Fill the index after a backfill.**

```
> Fill the pending folder memories and the root index TODOs.
```

**Rebuild or tighten an index entry.**

```
> Update the folder memory for src/api: the routes were split into v1 and v2.
> The root index line for web/ is too long, tighten it.
```

**Move or rename folders.** Nothing to do. The hook rewrites the `# path` header and carries the index description over to the new name.

## Configuration

Optional, per project: `.claude/advanced-memory.local.md` (Codex: `.codex/advanced-memory.local.md`; each host falls back to the other's file). Only the YAML frontmatter is read; the body is free-form notes.

```markdown
---
enabled: true             # false disables the plugin for this project
max_depth: 4              # folder depth tracked
ignore:                   # extra ignores: a name matches anywhere, a path matches that subtree
  - generated
  - docs/archive
language: english         # language for memory content (default: the project's dominant one)
max_lines: 40             # folder memory budget, in lines
max_index_chars: 120      # root index line budget, in characters
outdated_after_hours: 24  # SessionStart flags files modified this long after their memory
memory_file: AGENTS.md    # memory filename (default: CLAUDE.md in Claude Code, AGENTS.md in Codex)
---
```

Always ignored: dot-directories, `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `venv`, `vendor`, `tmp`, git-ignored paths, and symlinks.

Environment variables:

| Variable | Effect |
|---|---|
| `MEMORY_INDEXER_MAX_DEPTH` | Overrides `max_depth` (same as `--max-depth`) |
| `MEMORY_INDEXER_DEBUG=1` | Prints each hook result to stderr |

## Writing good index entries

The index only helps if a request can be matched against it. The skill follows these rules, and they apply equally if you edit entries yourself:

- **Root lines:** purpose first, then routing keys in parentheses: features, domains, entities, tech. Make keys that could match more than one folder specific: `login UI` vs `JWT middleware`, not just `auth` twice.
- **File entries:** say what a request would look for, and name the main exported symbols, routes, tables, or commands in backticks.
- **Group trivial files** with globs (`*.test.ts`). In folders with more than 15 files, list the key files plus a glob line.
- **`Stato`** holds current facts only (incomplete, broken, in progress), not history or plans.
- **Keep it short:** 40 lines per folder memory and 120 characters per root line by default. The `Stop` hook flags overruns.

## Limitations

- **Guidance, not enforcement.** The lookup protocol is an instruction Claude follows; no hook blocks repo-wide searches. In practice Claude follows it reliably when the index is filled.
- **Content drift is detected heuristically.** Structural changes (files added or removed) are caught exactly. Edits inside a file are only flagged when the file is modified more than `outdated_after_hours` after its memory.
- **Codex support is not covered by the e2e script.** Unit tests run the hook with Codex-shaped input; a live `codex exec` run is still to be added.
- **`apply_patch` matcher.** If your Codex version reports file edits under another tool name, new folders created by a patch are picked up at the next shell command or at `Stop` instead of immediately.
- **`claude plugin eval` can't test the lookup.** Its sandbox doesn't load project `CLAUDE.md` files, so lookup behavior is covered by the end-to-end script instead.

## Project layout

```
.claude-plugin/plugin.json      Claude Code plugin manifest
.codex-plugin/plugin.json       Codex plugin manifest
.agents/plugins/marketplace.json  Codex marketplace (this repo as one plugin)
hooks/hooks.json                SessionStart / PostToolUse / Stop wiring (both hosts)
scripts/dir-sync.mjs            structure sync, index maintenance, reminders
skills/memory-indexer/SKILL.md  lookup protocol and memory-writing rules
tests/dir-sync.test.mjs         unit tests (node:test)
tests/e2e-claude.sh             end-to-end tests with headless Claude Code
tests/fixtures/                 fixture projects for the e2e tests
evals/                          claude plugin eval cases (triggering, format)
```

## Development

```bash
npm test                    # unit tests
npm run validate            # e2e with headless claude: hook reacts to mkdir
FILL=1 npm run validate     # + skill fills a stub, rename keeps memory intact
LOOKUP=1 npm run validate   # + index-first lookup on a filled fixture project
npm run eval                # claude plugin eval: triggering + format, with/without plugin
```

The e2e phases run real `claude -p` sessions and use your Claude credentials.

## 🚀 Quick Start / Installation

Requirements: Claude Code or Codex CLI, and Node.js 18 or later.

### 🤖 1. For Claude Code
You can install `advanced-memory` directly from your terminal using the npm executor to clone and link the hooks automatically, or do it manually:

```bash
# Automated install via npx (creates stubs and sets up local hooks)
npx folder-memory-installer init

# Or manual installation
git clone https://github.com advanced-memory
claude --plugin-dir /path/to/advanced-memory
```

### 🧬 2. For Codex
Since this repository natively implements the `.codex-plugin/plugin.json` and behaves as a one-plugin marketplace, you can install it instantly via the Codex CLI using the GitHub shorthand:

```bash
codex plugin marketplace add m-ghiani/folder-memory
codex plugin add advanced-memory@folder-memory
```
*Codex will ask you to trust the plugin's hooks (`/hooks` in the TUI) upon the first execution.*

## License

MIT © Massimo Ghiani
