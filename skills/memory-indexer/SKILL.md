---
name: memory-indexer
description: Uses per-directory CLAUDE.md files as a lookup index (root index → folder memory → file) so Claude opens only the files a request needs instead of scanning the repo, and fills/maintains that index. Use before searching the codebase for where something lives or which file to change, when context contains a "memory-indexer:" message (fill folder memory, stale folder memory, too long, pending stubs, root index TODO, possibly outdated), when a CLAUDE.md holds `<!-- memory-indexer:stub -->`, or when the user asks to update/rebuild the directory index, folder memory, "indice directory" or "memoria di cartella".
---

# Memory Indexer

The `CLAUDE.md` files are an **index over the codebase**, like a database index over a table: the root lists folders, each folder memory lists files, and each entry says what it holds. Lookups walk the index; the index is only useful if its entries are written so a request can be matched against them.

## Lookup (every request that touches code)

1. **Root index** (always in context): match the request's nouns/features against the folder lines. Pick 1–2 candidates.
2. **Folder memory**: `Read` `<dir>/CLAUDE.md`. Match against **File** and **Sottocartelle**; descend into a subfolder the same way.
3. **Open only the named files.** Use their **Stato**/**Note** before reading code.
4. **Miss** (no entry matches, or the named file doesn't hold it): fall back to a scoped `Grep`/`Glob`, inside the candidate folder first, whole repo last.
5. **Repair the index** after a miss: in the managed file that should have routed you, add the missing keyword/symbol to the right entry (surgical edit). A stub on the path → fill it now. Never edit hand-written files; their content still routes, just read it.

Skip the lookup when the request already names exact paths, or for tasks that don't need the codebase.

## Maintenance

The `dir-sync` hook owns **structure**: it creates stubs, syncs index lines, and fixes `# path` headers when a folder moves. You own **content**. Never create, delete, or move `CLAUDE.md` files yourself unless the user asks.

| File | Role | Budget |
|---|---|---|
| `<root>/CLAUDE.md` | Directory index: top-level folders only | 1 line/folder, ≤ 120 chars* |
| `<dir>/CLAUDE.md` | Folder memory: files + local state | ≤ 40 lines* |

\* Defaults; the project may change them, and the hook reports overruns.

## Ownership

You may edit **only**:
- files containing `<!-- memory-indexer:stub -->` (replace them entirely);
- files ending with `<!-- memory-indexer:managed -->` (surgical edits only);
- the root block between `<!-- dir-index:start -->` and `<!-- dir-index:end -->`.

Any other `CLAUDE.md` is hand-written by the user: leave it alone.

## When to act

Finish the user's task first. The Stop hook then sends one reminder listing what needs attention:

| Message | Action |
|---|---|
| `fill folder memory → a, b` | Replace each stub with folder memory, deepest first |
| `stale folder memory → d (removed: x; new: y)` | Patch only **File**/**Sottocartelle**/**Stato** of `d` for those entries |
| `too long → d (52/40 lines)` / ``index `x/` (140/120 chars)`` | Tighten: merge trivial entries into globs, drop stale Stato lines. Keep Scopo |
| `pending stubs` / `root index TODO` (session start) | Informational. Fill them when you work in those folders |
| `possibly outdated → d (a.ts changed 3d after the memory)` (session start) | Informational. When you work in `d`, re-read those files and patch only the lines that changed |

Look cheaply: `ls` plus a skim of entry points and exports (first ~30 lines). Folders with more than 10 files: sample them. Bulk scaffold (more than 5 empty dirs): 2 lines each (`# path` + `**Scopo**`), inferred from the name and the task. Never invent files.

When you fill a top-level folder's memory, also replace its `_TODO` line in the root index.

## Root index

```markdown
<!-- dir-index:start -->
## Directory
- `routes/`: route API del servizio (Express, v1/v2)
- `scripts/`: utility CLI per seed e migrazioni
<!-- dir-index:end -->
```

- Exact format `` - `<name>/`: <purpose> (<keys>) ``: why the folder exists, then the **routing keys** a request would mention: features, domains, entities, tech. Example: `` - `api/`: HTTP API (users, orders, JWT auth, Express) ``.
- Keys must disambiguate: if two folders could match "auth", say which side each has (`login UI` vs `JWT middleware`).
- The `Lookup:` line under `## Directory` is written by the hook: never edit or remove it.
- Only replace descriptions. Never add, remove, or reorder lines: the hook syncs them.

## Folder memory

```markdown
# src/routes

**Scopo**: endpoint HTTP pubblici, un file per risorsa.

## File
- `users.ts`: CRUD utenti (`createUser`, `listUsers`), richiede JWT
- `*.test.ts`: test unitari

## Sottocartelle
- `v2/`: endpoint della nuova API

## Stato
- `users.ts`: paginazione mancante

<!-- memory-indexer:managed -->
```

- **Scopo** is required, one sentence. Every other section: include it only if it has real content.
- Each entry starts with `` - `name` ``. The hook parses these to detect staleness. Use globs (`*.test.ts`) to group trivial files. More than 15 files → key files plus a glob line.
- Write entries as **lookup keys**: what a request would ask for that this file answers. Name the main exported symbols, routes, tables, or commands in backticks, so a match needs no file open. A file nobody would look up → fold it into a glob.
- **Sottocartelle** entries route the descent: same style as root index lines (purpose + keys).
- **Stato**: current local facts (incomplete, broken, in progress). Not history, not plans.
- Optional `## Note`: folder-specific conventions or gotchas.
- Facts only. No generic advice. Don't repeat content from parent or child memory. Use the project's dominant language, unless a hook message says `Write memory in <language>`.
- Always keep `<!-- memory-indexer:managed -->` as the last line.

## Surgical edits (managed files)

When updating a managed file, change only the lines affected and keep every other line byte-for-byte, **Stato** and **Note** included. Use `Edit` on the specific lines, never `Write` over the whole file. A moved folder needs no action: the hook already rewrote its header.
