#!/usr/bin/env node
// dir-sync: detects new directories via snapshot diff, scaffolds CLAUDE.md
// stubs, maintains the root directory index, and nudges Claude (at Stop) to
// fill stubs and refresh stale folder memory.
//
// Modes:
//   diff     PostToolUse  silent structure work (stubs, index, moved headers)
//   stop     Stop         block once per session if memory needs attention
//   session  SessionStart diff + report pending stubs, root TODOs, outdated memory
//   backfill manual       stub every tracked dir lacking CLAUDE.md
//
// Anti-loop guarantees:
//   1. Writes go through `fs`, never through a Claude tool call, so they
//      cannot re-trigger PostToolUse.
//   2. Stubs are created with flag "wx" (fail if exists): never overwrite.
//   3. The snapshot is saved AFTER all writes, so the next diff is empty.
//   4. A lock file serializes concurrent hook invocations.
//   5. State lives in `.claude/` (a dotdir), which the scanner ignores.
//   6. Stop blocks at most once per item per session, never when
//      `stop_hook_active` is set.
//
// Per-project settings: `.claude/advanced-memory.local.md` (YAML frontmatter,
// see README). CLI flags / env vars override the file.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const STUB_MARKER = "<!-- memory-indexer:stub -->";
export const MANAGED_MARKER = "<!-- memory-indexer:managed -->";
export const INDEX_START = "<!-- dir-index:start -->";
export const INDEX_END = "<!-- dir-index:end -->";
export const TODO_DESC = "_TODO: descrizione_";
// Fixed line at the top of the root index: the root CLAUDE.md is always in
// context, so this is what makes Claude use the memory as an index on every
// request instead of scanning the tree.
export const LOOKUP_RULE =
  "**Lookup protocol (mandatory, before any Grep/Glob):** this index and each folder's `CLAUDE.md` map the codebase. " +
  "Match the request to a folder below, `Read` its `CLAUDE.md`, follow **Sottocartelle** down, open only the files it names. " +
  "Search with Grep/Glob only when the index has no match, scoped to the closest folder.";

const IGNORED_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage",
  "__pycache__", "venv", "vendor", "tmp",
]);
const STATE_DIR = ".claude";
const CONFIG_FILE = "advanced-memory.local.md";
const SNAPSHOT_FILE = ".dir-snapshot.json";
const NUDGE_FILE = ".dir-sync-nudge.json";
const LOCK_FILE = ".dir-sync.lock";
const LOCK_STALE_MS = 15_000;
const MTIME_SLACK_MS = 2_000;
const MAX_DIRS = 5_000;
const MAX_NAMES_PER_DIR = 5;
const WRITE_TOOLS = new Set(["Write"]);
const NO_FS_STRUCTURE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep"]);
const HOUR_MS = 3_600_000;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  max_depth: 4,
  ignore: [],
  language: "",
  max_lines: 40,
  max_index_chars: 120,
  outdated_after_hours: 24,
});

// ---------- config ----------

function parseScalar(v) {
  v = v.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Minimal YAML frontmatter parser: `k: v`, `k: [a, b]`, `k:` + `- a` lines. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      out[listKey].push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    listKey = null;
    if (v === "") {
      out[k] = [];
      listKey = k;
    } else if (/^\[.*\]$/.test(v.trim())) {
      out[k] = v.trim().slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).map(parseScalar);
    } else {
      out[k] = parseScalar(v);
    }
  }
  return out;
}

/** Defaults overlaid with `.claude/advanced-memory.local.md`; bad values fall back. */
export function loadConfig(root) {
  let raw = {};
  try {
    raw = parseFrontmatter(fs.readFileSync(path.join(root, STATE_DIR, CONFIG_FILE), "utf8"));
  } catch {}
  const cfg = { ...DEFAULT_CONFIG };
  for (const [k, def] of Object.entries(DEFAULT_CONFIG)) {
    const v = raw[k];
    if (v === undefined) continue;
    if (Array.isArray(def)) cfg[k] = (Array.isArray(v) ? v : [v]).map(String);
    else if (typeof def === typeof v && (typeof v !== "number" || v > 0)) cfg[k] = v;
  }
  return cfg;
}

// ---------- scan ----------

function isIgnoredName(name) {
  return name.startsWith(".") || IGNORED_NAMES.has(name);
}

/**
 * Ignore predicate from config patterns: a pattern without "/" matches an
 * entry name (`*.generated`), one with "/" matches a relative path and
 * everything beneath it (`docs/archive`, `packages/*\/fixtures`).
 */
export function makeIgnore(patterns = []) {
  const names = [];
  const paths = [];
  for (const pat of patterns) {
    const clean = String(pat).replace(/^\.?\//, "").replace(/\/$/, "");
    if (!clean) continue;
    (clean.includes("/") ? paths : names).push(globToRegExp(clean));
  }
  return (name, rel = name) =>
    isIgnoredName(name) ||
    names.some((g) => g.test(name)) ||
    paths.some((g) => rel.split("/").some((_, i, a) => g.test(a.slice(0, i + 1).join("/"))));
}

/** Relative POSIX paths of tracked directories, up to maxDepth. */
export function scanDirs(root, maxDepth, isIgnored = makeIgnore()) {
  const found = [];
  const walk = (abs, rel, depth) => {
    if (depth > maxDepth || found.length >= MAX_DIRS) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Dirent.isDirectory() is false for symlinks: no symlink loops.
      if (!e.isDirectory()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnored(e.name, childRel)) continue;
      found.push(childRel);
      walk(path.join(abs, e.name), childRel, depth + 1);
    }
  };
  walk(root, "", 1);
  return filterGitIgnored(root, found).sort();
}

function filterGitIgnored(root, dirs) {
  if (dirs.length === 0 || !fs.existsSync(path.join(root, ".git"))) return dirs;
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      input: dirs.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (err) {
    // Exit 1 = nothing ignored; anything else = git unavailable.
    out = typeof err.stdout === "string" ? err.stdout : "";
  }
  const ignored = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  if (ignored.size === 0) return dirs;
  // Drop ignored dirs and everything beneath them.
  return dirs.filter((d) => {
    for (const ig of ignored) if (d === ig || d.startsWith(`${ig}/`)) return false;
    return true;
  });
}

/**
 * Fast path for Write: true if the written file's ancestor dirs are all
 * already known (or untracked), so no new directory can exist.
 */
function writeCreatesNoDir(root, filePath, snapshot, maxDepth, isIgnored) {
  if (!filePath) return false;
  const rel = path.relative(root, path.resolve(root, filePath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // outside project
  const parts = rel.split(path.sep).slice(0, -1);
  for (let i = 0; i < parts.length && i < maxDepth; i++) {
    const rel = parts.slice(0, i + 1).join("/");
    if (isIgnored(parts[i], rel)) return true;
    if (!snapshot.has(rel)) return false;
  }
  return true;
}

// ---------- state ----------

function statePath(root, name) {
  return path.join(root, STATE_DIR, name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readSnapshot(root) {
  const raw = readJson(statePath(root, SNAPSHOT_FILE));
  return raw && Array.isArray(raw.dirs) ? new Set(raw.dirs) : null;
}

function acquireLock(root) {
  const lock = statePath(root, LOCK_FILE);
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
    return lock;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
        return lock;
      }
    } catch {}
    return null; // another invocation is running: skip silently
  }
}

// ---------- CLAUDE.md helpers ----------

function readMemory(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel, "CLAUDE.md"), "utf8");
  } catch {
    return null;
  }
}

export function stubContent(rel) {
  return `${STUB_MARKER}\n# ${rel}\n_TODO: memoria di cartella da compilare_\n`;
}

/** Create stub CLAUDE.md if absent. Returns true if created. */
function writeStub(root, rel) {
  try {
    fs.writeFileSync(path.join(root, rel, "CLAUDE.md"), stubContent(rel), { flag: "wx" });
    return true;
  } catch {
    return false; // exists or dir vanished: never overwrite
  }
}

/**
 * A managed memory that arrived in a new location (dir moved/renamed):
 * rewrite only its `# path` header. Returns the old path, or null.
 */
function fixMovedHeader(root, rel) {
  const text = readMemory(root, rel);
  if (!text || !text.includes(MANAGED_MARKER)) return null;
  const m = text.match(/^# (.+)$/m);
  if (!m || m[1].trim() === rel) return null;
  fs.writeFileSync(path.join(root, rel, "CLAUDE.md"), text.replace(/^# .+$/m, `# ${rel}`));
  return m[1].trim();
}

/** Build index block, preserving descriptions (also across renames). */
export function buildIndexBlock(existingBlock, topDirs, renames = {}) {
  const known = new Map();
  for (const line of (existingBlock || "").split("\n")) {
    const m = line.match(/^- `([^`]+?)\/`: (.*)$/);
    if (m && m[2].trim() !== TODO_DESC) known.set(m[1], m[2].trim());
  }
  const lines = topDirs.map((d) => `- \`${d}/\`: ${known.get(d) || known.get(renames[d]) || TODO_DESC}`);
  return [INDEX_START, "## Directory", LOOKUP_RULE, "", ...lines, INDEX_END].join("\n");
}

function readIndexBlock(text) {
  const s = text.indexOf(INDEX_START);
  const e = text.indexOf(INDEX_END);
  return s !== -1 && e > s ? { s, e: e + INDEX_END.length, block: text.slice(s, e + INDEX_END.length) } : null;
}

/** Update the block between markers in root CLAUDE.md. Returns true if changed. */
export function updateRootIndex(root, topDirs, renames = {}) {
  const file = path.join(root, "CLAUDE.md");
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}

  let next;
  if (text === null) {
    next = `# ${path.basename(root)}\n\n${buildIndexBlock("", topDirs)}\n`;
  } else {
    const idx = readIndexBlock(text);
    next = idx
      ? text.slice(0, idx.s) + buildIndexBlock(idx.block, topDirs, renames) + text.slice(idx.e)
      : `${text.replace(/\s*$/, "")}\n\n${buildIndexBlock("", topDirs)}\n`; // keep user content
  }
  if (next === text) return false;
  fs.writeFileSync(file, next);
  return true;
}

function rootTodos(root) {
  try {
    const idx = readIndexBlock(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"));
    if (!idx) return [];
    return [...idx.block.matchAll(/^- `([^`]+?)\/`: (.*)$/gm)]
      .filter((m) => m[2].trim() === TODO_DESC)
      .map((m) => m[1]);
  } catch {
    return [];
  }
}

function pendingStubs(root, dirs) {
  return dirs.filter((d) => readMemory(root, d)?.includes(STUB_MARKER));
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/**
 * Managed memories whose folder changed after the memory was written:
 * listed entries that no longer exist, or new entries never mentioned.
 */
export function staleMemories(root, dirs, isIgnored = makeIgnore()) {
  const out = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    const file = path.join(abs, "CLAUDE.md");
    let memMtime;
    try {
      // Cheap prefilter: entries added/removed bump the dir's mtime.
      memMtime = fs.statSync(file).mtimeMs;
      if (fs.statSync(abs).mtimeMs <= memMtime + MTIME_SLACK_MS) continue;
    } catch {
      continue;
    }
    const text = readMemory(root, d);
    if (!text || !text.includes(MANAGED_MARKER)) continue;

    const listed = [...text.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1].replace(/\/$/, ""));
    const globs = listed.filter((n) => /[*?]/.test(n)).map(globToRegExp);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== "CLAUDE.md" && !isIgnored(e.name, `${d}/${e.name}`));
    } catch {
      continue;
    }
    const names = new Set(entries.map((e) => e.name));

    const missing = listed.filter((n) => !/[*?/]/.test(n) && !names.has(n));
    const unlisted = entries
      .filter((e) => {
        if (text.includes(e.name) || globs.some((g) => g.test(e.name))) return false;
        const st = fs.statSync(path.join(abs, e.name));
        return (st.birthtimeMs || st.ctimeMs) > memMtime;
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

    if (missing.length || unlisted.length) {
      out.push({
        dir: d,
        missing: missing.slice(0, MAX_NAMES_PER_DIR),
        unlisted: unlisted.slice(0, MAX_NAMES_PER_DIR),
      });
    }
  }
  return out;
}

/** Managed memories over the line budget, root index lines over the char budget. */
export function oversizedMemories(root, dirs, cfg = DEFAULT_CONFIG) {
  const out = [];
  for (const d of dirs) {
    const text = readMemory(root, d);
    if (!text || !text.includes(MANAGED_MARKER)) continue;
    const lines = text.trimEnd().split("\n").length;
    if (lines > cfg.max_lines) out.push({ dir: d, lines, max: cfg.max_lines });
  }
  try {
    const idx = readIndexBlock(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"));
    for (const m of idx ? idx.block.matchAll(/^- `([^`]+?)\/`: .*$/gm) : []) {
      if (m[0].length > cfg.max_index_chars) out.push({ index: m[1], chars: m[0].length, max: cfg.max_index_chars });
    }
  } catch {}
  return out;
}

/**
 * Managed memories whose folder's files were modified well after the memory
 * (content drift the structural check cannot see). Newest files first.
 */
export function outdatedMemories(root, dirs, cfg = DEFAULT_CONFIG, isIgnored = makeIgnore()) {
  const threshold = cfg.outdated_after_hours * HOUR_MS;
  const out = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    let memMtime;
    try {
      memMtime = fs.statSync(path.join(abs, "CLAUDE.md")).mtimeMs;
    } catch {
      continue;
    }
    const text = readMemory(root, d);
    if (!text || !text.includes(MANAGED_MARKER)) continue;
    let files;
    try {
      files = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name !== "CLAUDE.md" && !isIgnored(e.name, `${d}/${e.name}`))
        .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(abs, e.name)).mtimeMs }))
        .filter((f) => f.mtime > memMtime + threshold)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
    }
    if (files.length) {
      const days = Math.max(1, Math.round((files[0].mtime - memMtime) / (24 * HOUR_MS)));
      out.push({ dir: d, files: files.slice(0, MAX_NAMES_PER_DIR).map((f) => f.name), days });
    }
  }
  return out;
}

// ---------- main logic ----------

/** Snapshot diff + structural writes. Caller holds the lock. */
function syncStructure(root, mode, maxDepth, snapshot, isIgnored) {
  const current = scanDirs(root, maxDepth, isIgnored);
  // First run on an existing project: baseline only, no stubs for
  // pre-existing dirs (use --mode=backfill for that).
  const baseline = snapshot === null && mode !== "backfill";
  const newDirs = baseline ? [] : current.filter((d) => !snapshot?.has(d));

  // Deepest first, so leaves are handled before parents.
  newDirs.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  const moved = [];
  for (const d of newDirs) {
    if (writeStub(root, d)) continue;
    const from = fixMovedHeader(root, d);
    if (from) moved.push({ from, to: d });
  }

  const renames = Object.fromEntries(
    moved.filter((m) => !m.to.includes("/") && !m.from.includes("/")).map((m) => [m.to, m.from]),
  );
  const topDirs = current.filter((d) => !d.includes("/"));
  const indexChanged = updateRootIndex(root, topDirs, renames);

  writeJsonAtomic(statePath(root, SNAPSHOT_FILE), { version: 1, dirs: current }); // after writes
  return { current, newDirs, moved, indexChanged, baseline };
}

/** Items Stop has not yet nudged about in this session. Records them. */
function unseenItems(root, sessionId, items) {
  const file = statePath(root, NUDGE_FILE);
  const state = readJson(file);
  const seen = new Set(state && state.session === sessionId ? state.keys : []);
  const fresh = items.filter((it) => !seen.has(it.key));
  if (fresh.length) {
    for (const it of fresh) seen.add(it.key);
    writeJsonAtomic(file, { session: sessionId, keys: [...seen] });
  }
  return fresh;
}

/**
 * @param {{root: string, mode: "diff"|"stop"|"session"|"backfill", maxDepth?: number, input?: object, config?: object}} opts
 *   maxDepth (CLI/env) overrides config.max_depth; config defaults to the project's settings file.
 */
export function run({ root, mode, maxDepth, input = {}, config }) {
  const empty = {
    newDirs: [], moved: [], pending: [], todos: [], stale: [], oversized: [], outdated: [],
    block: null, indexChanged: false, baseline: false, language: "",
  };
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? loadConfig(root)) };
  if (!cfg.enabled) return { ...empty, skipped: "disabled" };
  maxDepth ??= cfg.max_depth;
  const isIgnored = makeIgnore(cfg.ignore);
  empty.language = cfg.language;

  if (mode === "stop" && input.stop_hook_active) return { ...empty, skipped: "stop_hook_active" };
  if (mode === "diff" && NO_FS_STRUCTURE_TOOLS.has(input.tool_name)) return { ...empty, fastPath: true };

  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  const snapshot = readSnapshot(root);
  if (
    mode === "diff" && snapshot && WRITE_TOOLS.has(input.tool_name) &&
    writeCreatesNoDir(root, input.tool_input?.file_path, snapshot, maxDepth, isIgnored)
  ) {
    return { ...empty, fastPath: true };
  }

  const lock = acquireLock(root);
  if (!lock) return { ...empty, skipped: "locked" };

  try {
    const s = syncStructure(root, mode, maxDepth, snapshot, isIgnored);
    const result = { ...empty, ...s };
    delete result.current;

    if (mode === "session") {
      result.pending = pendingStubs(root, s.current);
      result.todos = rootTodos(root);
      result.outdated = outdatedMemories(root, s.current, cfg, isIgnored);
    }
    if (mode === "stop") {
      result.pending = pendingStubs(root, s.current);
      result.stale = staleMemories(root, s.current, isIgnored);
      result.oversized = oversizedMemories(root, s.current, cfg);
      const items = [
        ...result.pending.map((d) => ({ key: `stub:${d}`, kind: "stub", dir: d })),
        ...result.stale.map((st) => ({ key: `stale:${st.dir}:${[...st.missing, ...st.unlisted].join(",")}`, kind: "stale", ...st })),
        ...result.oversized.map((o) => ({ key: o.dir ? `long:${o.dir}:${o.lines}` : `longidx:${o.index}:${o.chars}`, kind: "long", ...o })),
      ];
      const fresh = unseenItems(root, input.session_id || "no-session", items);
      result.block = fresh.length ? fresh : null;
    }
    return result;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** SessionStart additionalContext (informational, non-blocking). */
export function formatContext(result, mode) {
  const parts = [];
  if (result.pending.length) parts.push(`memory-indexer: pending stubs → ${result.pending.join(", ")}`);
  if (result.todos.length) parts.push(`memory-indexer: root index TODO → ${result.todos.join(", ")}`);
  for (const o of result.outdated) {
    parts.push(`memory-indexer: possibly outdated → ${o.dir} (${o.files.join(", ")} changed ${o.days}d after the memory)`);
  }
  if (!parts.length) return null;
  parts.push("Fill or refresh them following the memory-indexer skill when you work in those folders; the Stop hook will remind you about stubs before finishing.");
  if (result.language) parts.push(`Write memory in ${result.language}.`);
  return {
    hookSpecificOutput: {
      hookEventName: mode === "session" ? "SessionStart" : "PostToolUse",
      additionalContext: parts.join("\n"),
    },
  };
}

/** Stop hook decision: block once with the list of memory to update. */
export function formatStop(result) {
  if (!result.block) return null;
  const stubs = result.block.filter((i) => i.kind === "stub").map((i) => i.dir);
  const stale = result.block.filter((i) => i.kind === "stale");
  const lines = [];
  if (stubs.length) lines.push(`memory-indexer: fill folder memory → ${stubs.join(", ")}`);
  for (const st of stale) {
    const bits = [];
    if (st.missing.length) bits.push(`removed: ${st.missing.join(", ")}`);
    if (st.unlisted.length) bits.push(`new: ${st.unlisted.join(", ")}`);
    lines.push(`memory-indexer: stale folder memory → ${st.dir} (${bits.join("; ")})`);
  }
  const long = result.block.filter((i) => i.kind === "long");
  if (long.length) {
    const what = long.map((o) => (o.dir ? `${o.dir} (${o.lines}/${o.max} lines)` : `index \`${o.index}/\` (${o.chars}/${o.max} chars)`));
    lines.push(`memory-indexer: too long → ${what.join(", ")}`);
  }
  lines.push("Update these CLAUDE.md files following the memory-indexer skill, then finish.");
  if (result.language) lines.push(`Write memory in ${result.language}.`);
  return { decision: "block", reason: lines.join("\n") };
}

function readStdin() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    }),
  );
  const mode = ["diff", "stop", "session", "backfill"].includes(args.mode) ? args.mode : "diff";
  const input = readStdin();
  const root = path.resolve(
    args.root || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(),
  );
  const maxDepth = Number(args["max-depth"] || process.env.MEMORY_INDEXER_MAX_DEPTH) || undefined;

  // Never touch $HOME or filesystem root by accident.
  if (root === path.parse(root).root || root === process.env.HOME) return;

  const result = run({ root, mode, maxDepth, input });
  const out = mode === "stop" ? formatStop(result) : mode === "session" ? formatContext(result, mode) : null;
  if (out) process.stdout.write(JSON.stringify(out));
  if (process.env.MEMORY_INDEXER_DEBUG) process.stderr.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (err) {
    // A memory hook must never break the session.
    if (process.env.MEMORY_INDEXER_DEBUG) process.stderr.write(`dir-sync error: ${err.stack}\n`);
  }
  process.exit(0);
}
