import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  run,
  formatContext,
  formatStop,
  scanDirs,
  staleMemories,
  parseFrontmatter,
  loadConfig,
  oversizedMemories,
  outdatedMemories,
  STUB_MARKER,
  MANAGED_MARKER,
  INDEX_START,
  LOOKUP_RULE,
  INDEX_END,
  TODO_DESC,
  lookupRule,
  detectHost,
  findProjectRoot,
  patchTargets,
} from "../scripts/dir-sync.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/dir-sync.mjs");

let root;
const p = (...parts) => path.join(root, ...parts);
const read = (...parts) => fs.readFileSync(p(...parts), "utf8");
const exists = (...parts) => fs.existsSync(p(...parts));
const mkdir = (rel) => fs.mkdirSync(p(rel), { recursive: true });

/** Invoke the script exactly like Claude Code does: stdin JSON, env, exit code. */
function hook(mode, stdin = { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root }) {
  const res = spawnSync("node", [SCRIPT, `--mode=${mode}`], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dir-sync-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("mkdir test-dir (core flow)", () => {
  test("creates stub in new dir and indexes it in root", () => {
    run({ root, mode: "diff" }); // baseline
    mkdir("test-dir");
    const r = run({ root, mode: "diff" });

    assert.deepEqual(r.newDirs, ["test-dir"]);
    assert.ok(read("test-dir", "CLAUDE.md").startsWith(STUB_MARKER));
    assert.match(read("test-dir", "CLAUDE.md"), /^# test-dir$/m);

    const rootMd = read("CLAUDE.md");
    assert.ok(rootMd.includes(INDEX_START) && rootMd.includes(INDEX_END));
    assert.ok(rootMd.includes(`- \`test-dir/\`: ${TODO_DESC}`));
  });

  test("end-to-end via hook processes: diff silent, Stop blocks with valid JSON", () => {
    assert.equal(hook("diff").code, 0); // baseline
    mkdir("test-dir");
    const diff = hook("diff");
    assert.equal(diff.code, 0);
    assert.equal(diff.stdout, "", "PostToolUse stays silent: no mid-task nudge");
    assert.ok(exists("test-dir", "CLAUDE.md"));

    const stop = hook("stop", { hook_event_name: "Stop", session_id: "s1", stop_hook_active: false });
    assert.equal(stop.code, 0);
    const out = JSON.parse(stop.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /memory-indexer: fill folder memory → test-dir/);
  });

  test("nested mkdir -p: every level stubbed, deepest first", () => {
    run({ root, mode: "diff" });
    mkdir("a/b/c");
    const r = run({ root, mode: "diff" });

    assert.deepEqual(r.newDirs, ["a/b/c", "a/b", "a"]);
    for (const d of r.newDirs) assert.ok(exists(d, "CLAUDE.md"), d);
    assert.ok(read("CLAUDE.md").includes("- `a/`:"));
    assert.ok(!read("CLAUDE.md").includes("a/b/"), "root index lists top-level only");
  });

  test("dir created implicitly by a Write (file in new folder)", () => {
    run({ root, mode: "diff" });
    mkdir("src/routes");
    fs.writeFileSync(p("src/routes/users.ts"), "export {}\n");
    const r = run({ root, mode: "diff" });
    assert.deepEqual(r.newDirs, ["src/routes", "src"]);
  });
});

describe("anti-loop / idempotency", () => {
  test("second run after creation is a no-op (no output, no writes)", () => {
    hook("diff");
    mkdir("test-dir");
    hook("diff");

    const before = { root: read("CLAUDE.md"), stub: read("test-dir", "CLAUDE.md"), mtime: fs.statSync(p("CLAUDE.md")).mtimeMs };
    const res = hook("diff");

    assert.equal(res.code, 0);
    assert.equal(res.stdout, "", "no context injected on unchanged tree");
    assert.equal(read("CLAUDE.md"), before.root);
    assert.equal(read("test-dir", "CLAUDE.md"), before.stub);
    assert.equal(fs.statSync(p("CLAUDE.md")).mtimeMs, before.mtime, "root file not rewritten");
  });

  test("hook chain: 10 consecutive invocations report a new dir exactly once", () => {
    run({ root, mode: "diff" });
    mkdir("test-dir");
    const reports = Array.from({ length: 10 }, () => run({ root, mode: "diff" }).newDirs.length);
    assert.deepEqual(reports, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("files written by the hook never count as new directories", () => {
    run({ root, mode: "diff" });
    mkdir("x");
    run({ root, mode: "diff" });
    const snap = JSON.parse(read(".claude", ".dir-snapshot.json"));
    assert.ok(!snap.dirs.some((d) => d.startsWith(".claude")), "state dir not tracked");
  });

  test("never overwrites an existing CLAUDE.md in a new dir", () => {
    run({ root, mode: "diff" });
    mkdir("keep");
    fs.writeFileSync(p("keep", "CLAUDE.md"), "# my notes\n");
    run({ root, mode: "diff" });
    assert.equal(read("keep", "CLAUDE.md"), "# my notes\n");
  });

  test("renamed dir, hand-written memory: left untouched", () => {
    run({ root, mode: "diff" });
    mkdir("old-name");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("old-name", "CLAUDE.md"), "# old-name\n\n**Scopo**: by hand.\n");
    fs.renameSync(p("old-name"), p("new-name"));

    const r = run({ root, mode: "diff" });
    assert.deepEqual(r.newDirs, ["new-name"]);
    assert.deepEqual(r.moved, []);
    assert.equal(read("new-name", "CLAUDE.md"), "# old-name\n\n**Scopo**: by hand.\n");
    assert.ok(!read("CLAUDE.md").includes("`old-name/`"));
  });

  test("fresh lock held by another invocation → skip silently", () => {
    run({ root, mode: "diff" });
    fs.writeFileSync(p(".claude", ".dir-sync.lock"), "999");
    mkdir("test-dir");

    const r = run({ root, mode: "diff" });
    assert.equal(r.skipped, "locked");
    assert.ok(!exists("test-dir", "CLAUDE.md"));
    assert.ok(exists(".claude", ".dir-sync.lock"), "foreign lock untouched");
  });

  test("stale lock is recovered, dir picked up", () => {
    run({ root, mode: "diff" });
    const lock = p(".claude", ".dir-sync.lock");
    fs.writeFileSync(lock, "999");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    mkdir("test-dir");

    const r = run({ root, mode: "diff" });
    assert.deepEqual(r.newDirs, ["test-dir"]);
    assert.ok(!fs.existsSync(lock), "lock released");
  });
});

describe("root index", () => {
  test("first run (baseline) indexes existing dirs but stubs nothing", () => {
    mkdir("existing/deep");
    const r = run({ root, mode: "diff" });
    assert.equal(r.baseline, true);
    assert.deepEqual(r.newDirs, []);
    assert.ok(!exists("existing", "CLAUDE.md"));
    assert.ok(read("CLAUDE.md").includes(`- \`existing/\`: ${TODO_DESC}`));
  });

  test("backfill mode stubs pre-existing dirs", () => {
    mkdir("existing/deep");
    const r = run({ root, mode: "backfill" });
    assert.deepEqual(r.newDirs, ["existing/deep", "existing"]);
    assert.ok(exists("existing", "deep", "CLAUDE.md"));
  });

  test("preserves user content outside markers and filled descriptions", () => {
    mkdir("routes");
    fs.writeFileSync(
      p("CLAUDE.md"),
      `# Project\n\nUser rules here.\n\n${INDEX_START}\n## Directory\n- \`routes/\`: route API del servizio\n${INDEX_END}\n\n## Footer\n`,
    );
    run({ root, mode: "diff" });
    mkdir("models");
    run({ root, mode: "diff" });

    const md = read("CLAUDE.md");
    assert.ok(md.startsWith("# Project\n\nUser rules here.\n\n"));
    assert.ok(md.endsWith("\n\n## Footer\n"));
    assert.ok(md.includes("- `routes/`: route API del servizio"), "description kept");
    assert.ok(md.includes(`- \`models/\`: ${TODO_DESC}`));
    assert.ok(md.indexOf("`models/`") < md.indexOf("`routes/`"), "alphabetical");
  });

  test("index block carries the lookup rule exactly once", () => {
    fs.writeFileSync(p("CLAUDE.md"), `${INDEX_START}\n## Directory\n- \`routes/\`: route API\n${INDEX_END}\n`);
    mkdir("routes");
    run({ root, mode: "diff" });
    mkdir("models");
    run({ root, mode: "diff" });
    const md = read("CLAUDE.md");
    assert.equal(md.split(LOOKUP_RULE).length - 1, 1);
    assert.ok(md.indexOf(LOOKUP_RULE) < md.indexOf("`models/`"), "rule before entries");
    assert.ok(md.includes("- `routes/`: route API"), "description kept");
  });

  test("appends block when root CLAUDE.md has no markers", () => {
    fs.writeFileSync(p("CLAUDE.md"), "# Existing\n\nKeep me.\n");
    mkdir("lib");
    run({ root, mode: "diff" });
    const md = read("CLAUDE.md");
    assert.ok(md.startsWith("# Existing\n\nKeep me.\n\n" + INDEX_START));
  });

  test("removed top-level dir disappears from index", () => {
    mkdir("old");
    mkdir("new");
    run({ root, mode: "diff" });
    fs.rmSync(p("old"), { recursive: true });
    run({ root, mode: "diff" });
    assert.ok(!read("CLAUDE.md").includes("`old/`"));
    assert.ok(read("CLAUDE.md").includes("`new/`"));
  });
});

describe("ignore rules", () => {
  test("skips dotdirs, build dirs, and dirs beyond max depth", () => {
    for (const d of [".hidden/x", "node_modules/pkg", "dist", "__pycache__", "l1/l2/l3/l4/l5"]) mkdir(d);
    const dirs = scanDirs(root, 4);
    assert.deepEqual(dirs, ["l1", "l1/l2", "l1/l2/l3", "l1/l2/l3/l4"]);
  });

  test("skips gitignored dirs and their children", (t) => {
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
    } catch {
      return t.skip("git not available");
    }
    fs.writeFileSync(p(".gitignore"), "generated/\n");
    mkdir("generated/sub");
    mkdir("src");
    assert.deepEqual(scanDirs(root, 4), ["src"]);
  });

  test("does not follow symlinked dirs", () => {
    mkdir("real");
    fs.symlinkSync(p("real"), p("link"), "dir");
    assert.deepEqual(scanDirs(root, 4), ["real"]);
  });
});

describe("session start", () => {
  test("reports pending stubs; filled ones are not reported", () => {
    run({ root, mode: "diff" });
    mkdir("todo");
    mkdir("done");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("done", "CLAUDE.md"), "# done\n\n**Scopo**: filled.\n");

    const r = run({ root, mode: "session" });
    assert.deepEqual(r.pending, ["todo"]);
    const ctx = formatContext(r, "session");
    assert.equal(ctx.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(ctx.hookSpecificOutput.additionalContext, /pending stubs → todo/);
  });

  test("catches dirs created outside the session (e.g. from IDE)", () => {
    run({ root, mode: "diff" });
    mkdir("from-ide");
    const r = run({ root, mode: "session" });
    assert.deepEqual(r.newDirs, ["from-ide"]);
  });
});

describe("robustness", () => {
  test("malformed stdin → exit 0, still works via env", () => {
    hook("diff");
    mkdir("test-dir");
    const res = hook("diff", "{not json");
    assert.equal(res.code, 0);
    assert.ok(exists("test-dir", "CLAUDE.md"));
  });

  test("refuses to run on $HOME", () => {
    const res = spawnSync("node", [SCRIPT, "--mode=diff"], {
      input: "{}",
      env: { ...process.env, CLAUDE_PROJECT_DIR: os.homedir(), HOME: os.homedir() },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });
});

// ---------- helpers for managed memory ----------

const managed = (rel, body) => `# ${rel}\n\n**Scopo**: test.\n\n${body}\n${MANAGED_MARKER}\n`;
function ageFile(rel, ms = 60_000) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p(rel), t, t);
}
const stopInput = (session = "s1", active = false) => ({ session_id: session, stop_hook_active: active });

describe("moved managed memory (hook fixes header)", () => {
  test("top-level rename: header rewritten, Stato kept byte-for-byte, index description carried", () => {
    run({ root, mode: "diff" });
    mkdir("old-name");
    run({ root, mode: "diff" });
    const body = "## File\n- `a.ts`: thing\n\n## Stato\n- SENTINEL keep me\n";
    fs.writeFileSync(p("old-name", "CLAUDE.md"), managed("old-name", body));
    fs.writeFileSync(p("CLAUDE.md"), read("CLAUDE.md").replace(`\`old-name/\`: ${TODO_DESC}`, "`old-name/`: purpose kept"));
    fs.renameSync(p("old-name"), p("new-name"));

    const r = run({ root, mode: "diff" });
    assert.deepEqual(r.moved, [{ from: "old-name", to: "new-name" }]);
    assert.equal(read("new-name", "CLAUDE.md"), managed("new-name", body));
    assert.ok(read("CLAUDE.md").includes("- `new-name/`: purpose kept"));
    assert.ok(!read("CLAUDE.md").includes("old-name"));
  });

  test("nested memories follow a parent rename", () => {
    run({ root, mode: "diff" });
    mkdir("a/sub");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("a/sub/CLAUDE.md"), managed("a/sub", ""));
    fs.renameSync(p("a"), p("b"));

    const r = run({ root, mode: "diff" });
    assert.ok(r.moved.some((m) => m.from === "a/sub" && m.to === "b/sub"));
    assert.match(read("b/sub/CLAUDE.md"), /^# b\/sub$/m);
    assert.ok(read("b/CLAUDE.md").startsWith(STUB_MARKER), "unmanaged stub moved as-is stays pending");
  });
});

describe("Stop hook (deferred nudge)", () => {
  test("blocks once per session for pending stubs", () => {
    run({ root, mode: "diff" });
    mkdir("x");
    run({ root, mode: "diff" });

    const first = run({ root, mode: "stop", input: stopInput() });
    assert.equal(first.block.length, 1);
    assert.match(formatStop(first).reason, /fill folder memory → x/);

    const second = run({ root, mode: "stop", input: stopInput() });
    assert.equal(second.block, null, "same items, same session: no re-block");
    assert.equal(formatStop(second), null);
  });

  test("never blocks when stop_hook_active (no loop)", () => {
    run({ root, mode: "diff" });
    mkdir("x");
    const r = run({ root, mode: "stop", input: stopInput("s1", true) });
    assert.equal(r.block, null);
    assert.equal(r.skipped, "stop_hook_active");
  });

  test("new session reminds again", () => {
    run({ root, mode: "diff" });
    mkdir("x");
    run({ root, mode: "stop", input: stopInput("s1") });
    assert.ok(run({ root, mode: "stop", input: stopInput("s2") }).block);
  });

  test("new item in same session blocks again, listing only the new one", () => {
    run({ root, mode: "diff" });
    mkdir("x");
    run({ root, mode: "stop", input: stopInput() });
    mkdir("y");
    const r = run({ root, mode: "stop", input: stopInput() });
    assert.deepEqual(r.block.map((i) => i.dir), ["y"]);
  });

  test("Stop catches dirs created by Bash without a prior PostToolUse", () => {
    run({ root, mode: "diff" });
    mkdir("late");
    const r = run({ root, mode: "stop", input: stopInput() });
    assert.ok(exists("late", "CLAUDE.md"));
    assert.deepEqual(r.block.map((i) => i.dir), ["late"]);
  });

  test("nothing pending → no block", () => {
    run({ root, mode: "diff" });
    assert.equal(run({ root, mode: "stop", input: stopInput() }).block, null);
  });
});

describe("stale managed memory", () => {
  function setup(body, files) {
    run({ root, mode: "diff" });
    mkdir("lib");
    run({ root, mode: "diff" });
    for (const f of files) fs.writeFileSync(p("lib", f), "x");
    fs.writeFileSync(p("lib", "CLAUDE.md"), managed("lib", body));
    ageFile("lib/CLAUDE.md");
    ageFile("lib");
  }

  test("listed file removed → stale (removed)", () => {
    setup("## File\n- `a.ts`: a\n- `b.ts`: b", ["a.ts", "b.ts"]);
    fs.rmSync(p("lib", "b.ts"));
    assert.deepEqual(staleMemories(root, ["lib"]), [{ dir: "lib", missing: ["b.ts"], unlisted: [] }]);
  });

  test("new unmentioned file → stale (new); glob-covered file ignored", () => {
    setup("## File\n- `a.ts`: a\n- `*.test.ts`: tests", ["a.ts"]);
    fs.writeFileSync(p("lib", "c.ts"), "x");
    fs.writeFileSync(p("lib", "c.test.ts"), "x");
    fs.mkdirSync(p("lib", "sub"));
    const st = staleMemories(root, ["lib"]);
    assert.deepEqual(st[0].missing, []);
    assert.deepEqual(st[0].unlisted.sort(), ["c.ts", "sub/"]);
  });

  test("memory updated after the change → not stale", () => {
    setup("## File\n- `a.ts`: a", ["a.ts"]);
    fs.writeFileSync(p("lib", "c.ts"), "x");
    fs.writeFileSync(p("lib", "CLAUDE.md"), managed("lib", "## File\n- `a.ts`: a\n- `c.ts`: c"));
    assert.deepEqual(staleMemories(root, ["lib"]), []);
  });

  test("hand-written (unmanaged) memory is never reported", () => {
    setup("", ["a.ts"]);
    fs.writeFileSync(p("lib", "CLAUDE.md"), "# lib by hand\n");
    ageFile("lib/CLAUDE.md");
    fs.writeFileSync(p("lib", "new.ts"), "x");
    assert.deepEqual(staleMemories(root, ["lib"]), []);
  });

  test("Stop reports stale memory with details", () => {
    setup("## File\n- `a.ts`: a\n- `gone.ts`: g", ["a.ts", "gone.ts"]);
    fs.rmSync(p("lib", "gone.ts"));
    fs.writeFileSync(p("lib", "fresh.ts"), "x");
    const r = run({ root, mode: "stop", input: stopInput() });
    assert.match(formatStop(r).reason, /stale folder memory → lib \(removed: gone\.ts; new: fresh\.ts\)/);
  });
});

describe("session start: root TODOs", () => {
  test("pre-existing top-level dirs with TODO descriptions are reported", () => {
    mkdir("existing");
    mkdir("described");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("CLAUDE.md"), read("CLAUDE.md").replace(`\`described/\`: ${TODO_DESC}`, "`described/`: ok"));

    const r = run({ root, mode: "session" });
    assert.deepEqual(r.todos, ["existing"]);
    assert.match(formatContext(r, "session").hookSpecificOutput.additionalContext, /root index TODO → existing/);
  });
});

describe("fast path", () => {
  test("Edit/MultiEdit never scan", () => {
    run({ root, mode: "diff" });
    mkdir("sneaky");
    const r = run({ root, mode: "diff", input: { tool_name: "Edit", tool_input: { file_path: p("x.ts") } } });
    assert.equal(r.fastPath, true);
    assert.ok(!exists("sneaky", "CLAUDE.md"));
  });

  test("Write into a known dir skips the scan", () => {
    mkdir("src");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("src", "a.ts"), "x");
    const r = run({ root, mode: "diff", input: { tool_name: "Write", tool_input: { file_path: p("src", "a.ts") } } });
    assert.equal(r.fastPath, true);
  });

  test("Write creating a new dir triggers the full scan", () => {
    mkdir("src");
    run({ root, mode: "diff" });
    mkdir("src/new");
    fs.writeFileSync(p("src/new/a.ts"), "x");
    const r = run({ root, mode: "diff", input: { tool_name: "Write", tool_input: { file_path: p("src/new/a.ts") } } });
    assert.equal(r.fastPath, undefined);
    assert.deepEqual(r.newDirs, ["src/new"]);
  });

  test("Write outside the project or into ignored dir skips", () => {
    run({ root, mode: "diff" });
    for (const fp of ["/etc/hosts", p("node_modules/x/a.js")]) {
      const r = run({ root, mode: "diff", input: { tool_name: "Write", tool_input: { file_path: fp } } });
      assert.equal(r.fastPath, true, fp);
    }
  });
});

describe("config (.claude/advanced-memory.local.md)", () => {
  const writeConfig = (fm) => {
    fs.mkdirSync(p(".claude"), { recursive: true });
    fs.writeFileSync(p(".claude", "advanced-memory.local.md"), `---\n${fm}\n---\n\nNotes for humans.\n`);
  };

  test("frontmatter parser: scalars, inline lists, block lists, comments", () => {
    const fm = parseFrontmatter("---\nenabled: false\nmax_depth: 2 # shallow\nlanguage: \"italiano\"\nignore: [docs, *.gen]\nextra:\n  - a\n  - b\n---\nbody");
    assert.deepEqual(fm, { enabled: false, max_depth: 2, language: "italiano", ignore: ["docs", "*.gen"], extra: ["a", "b"] });
  });

  test("missing file → defaults; invalid values fall back", () => {
    assert.equal(loadConfig(root).max_lines, 40);
    writeConfig("max_lines: -3\nenabled: yes\nignore: docs");
    const cfg = loadConfig(root);
    assert.equal(cfg.max_lines, 40);
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.ignore, ["docs"]);
  });

  test("enabled: false disables every mode", () => {
    writeConfig("enabled: false");
    mkdir("x");
    for (const mode of ["session", "diff", "stop"]) assert.equal(run({ root, mode }).skipped, "disabled");
    assert.ok(!exists("CLAUDE.md"));
    assert.ok(!exists(".claude", ".dir-snapshot.json"));
  });

  test("ignore patterns: by name and by path", () => {
    writeConfig("ignore:\n  - generated\n  - docs/archive");
    run({ root, mode: "diff" });
    for (const d of ["generated", "src/generated", "docs/archive/old", "docs/live"]) mkdir(d);
    const r = run({ root, mode: "diff" });
    assert.deepEqual(r.newDirs.sort(), ["docs", "docs/live", "src"]);
    assert.ok(!exists("generated", "CLAUDE.md"));
  });

  test("max_depth from config; CLI/env maxDepth overrides it", () => {
    writeConfig("max_depth: 1");
    run({ root, mode: "diff" });
    mkdir("a/b");
    assert.deepEqual(run({ root, mode: "diff" }).newDirs, ["a"]);
    assert.deepEqual(run({ root, mode: "diff", maxDepth: 4 }).newDirs, ["a/b"]);
  });

  test("language is forwarded to Stop and SessionStart messages", () => {
    writeConfig("language: English");
    run({ root, mode: "diff" });
    mkdir("x");
    run({ root, mode: "diff" });
    assert.match(formatStop(run({ root, mode: "stop", input: stopInput() })).reason, /Write memory in English\./);
    assert.match(formatContext(run({ root, mode: "session" }), "session").hookSpecificOutput.additionalContext, /Write memory in English\./);
  });
});

describe("length budget", () => {
  test("managed memory over max_lines and long index lines are reported at Stop", () => {
    run({ root, mode: "diff" });
    mkdir("big");
    run({ root, mode: "diff" });
    const body = Array.from({ length: 45 }, (_, i) => `- \`f${i}.ts\`: x`).join("\n");
    fs.writeFileSync(p("big", "CLAUDE.md"), managed("big", body));
    fs.writeFileSync(p("CLAUDE.md"), read("CLAUDE.md").replace(`\`big/\`: ${TODO_DESC}`, `\`big/\`: ${"y".repeat(130)}`));

    const r = run({ root, mode: "stop", input: stopInput() });
    assert.equal(r.oversized.length, 2);
    assert.match(formatStop(r).reason, /too long → big \(\d+\/40 lines\), index `big\/` \(\d+\/120 chars\)/);
  });

  test("thresholds come from config; hand-written files ignored", () => {
    run({ root, mode: "diff" });
    mkdir("a");
    mkdir("b");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("a", "CLAUDE.md"), managed("a", "- `x`: 1\n- `y`: 2"));
    fs.writeFileSync(p("b", "CLAUDE.md"), "line\n".repeat(100));
    const cfg = { max_lines: 5, max_index_chars: 120 };
    assert.deepEqual(oversizedMemories(root, ["a", "b"], cfg), [{ dir: "a", lines: 7, max: 5 }]);
  });
});

describe("outdated memory (SessionStart)", () => {
  function setup(hoursAfter) {
    run({ root, mode: "diff" });
    mkdir("lib");
    run({ root, mode: "diff" });
    fs.writeFileSync(p("lib", "a.ts"), "x");
    fs.writeFileSync(p("lib", "CLAUDE.md"), managed("lib", "## File\n- `a.ts`: a"));
    const mem = new Date(Date.now() - (hoursAfter + 1) * 3_600_000);
    fs.utimesSync(p("lib", "CLAUDE.md"), mem, mem);
  }

  test("file modified well after its memory → reported", () => {
    setup(48);
    const r = run({ root, mode: "session" });
    assert.deepEqual(r.outdated.map((o) => [o.dir, o.files]), [["lib", ["a.ts"]]]);
    assert.match(formatContext(r, "session").hookSpecificOutput.additionalContext, /possibly outdated → lib \(a\.ts changed 2d after the memory\)/);
  });

  test("recent drift under the threshold → not reported", () => {
    setup(2);
    assert.deepEqual(run({ root, mode: "session" }).outdated, []);
  });

  test("threshold configurable; unmanaged memory ignored", () => {
    setup(2);
    assert.equal(outdatedMemories(root, ["lib"], { outdated_after_hours: 1 }).length, 1);
    fs.writeFileSync(p("lib", "CLAUDE.md"), "# by hand\n");
    const old = new Date(Date.now() - 100 * 3_600_000);
    fs.utimesSync(p("lib", "CLAUDE.md"), old, old);
    assert.deepEqual(outdatedMemories(root, ["lib"], { outdated_after_hours: 1 }), []);
  });
});

describe("Codex host", () => {
  const codexInput = (extra = {}) => ({
    hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root,
    session_id: "s1", turn_id: "t1", model: "gpt", ...extra,
  });
  /** Invoke the script like Codex does: no CLAUDE_PROJECT_DIR, turn_id in stdin. */
  function codexHook(mode, stdin) {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const res = spawnSync("node", [SCRIPT, `--mode=${mode}`], { input: JSON.stringify(stdin), env, encoding: "utf8" });
    return { code: res.status, stdout: res.stdout };
  }

  test("detects the host from the stdin shape", () => {
    assert.equal(detectHost(codexInput()), "codex");
    assert.equal(detectHost({ tool_name: "Bash", session_id: "s" }), "claude");
    assert.equal(detectHost(), "claude");
  });

  test("uses AGENTS.md and .codex/ state, never CLAUDE.md", () => {
    run({ root, mode: "diff", input: codexInput() });
    mkdir("api");
    const r = run({ root, mode: "diff", input: codexInput() });
    assert.equal(r.host, "codex");
    assert.ok(read("api", "AGENTS.md").startsWith(STUB_MARKER));
    assert.ok(read("AGENTS.md").includes(lookupRule("codex")));
    assert.ok(read("AGENTS.md").includes("`api/`"));
    assert.ok(exists(".codex", ".dir-snapshot.json"));
    assert.ok(!exists("CLAUDE.md") && !exists("api", "CLAUDE.md") && !exists(".claude"));
  });

  test("codex lookup rule names AGENTS.md and shell search tools", () => {
    const rule = lookupRule("codex");
    assert.match(rule, /`AGENTS\.md`/);
    assert.match(rule, /rg\/find/);
    assert.doesNotMatch(rule, /CLAUDE\.md|Grep\/Glob/);
  });

  test("memory_file config overrides the host default", () => {
    mkdir(".codex");
    fs.writeFileSync(p(".codex", "advanced-memory.local.md"), "---\nmemory_file: CLAUDE.md\n---\n");
    run({ root, mode: "diff", input: codexInput() });
    mkdir("lib");
    run({ root, mode: "diff", input: codexInput() });
    assert.ok(exists("lib", "CLAUDE.md"));
    assert.ok(!exists("lib", "AGENTS.md"));
    assert.ok(read("CLAUDE.md").includes(lookupRule("codex", "CLAUDE.md")));
  });

  test("invalid memory_file falls back to the host default", () => {
    mkdir(".codex");
    fs.writeFileSync(p(".codex", "advanced-memory.local.md"), "---\nmemory_file: ../evil.md\n---\n");
    assert.equal(loadConfig(root, "codex").memory_file, "");
  });

  test("Stop blocks with the AGENTS.md wording", () => {
    run({ root, mode: "diff", input: codexInput() });
    mkdir("svc");
    const r = run({ root, mode: "stop", input: codexInput({ hook_event_name: "Stop", stop_hook_active: false }) });
    const out = formatStop(r);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /fill folder memory → svc/);
    assert.match(out.reason, /Update these AGENTS\.md files/);
  });

  test("CLI: root resolved from a subfolder cwd via .git, exit 0", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdir("pkg/deep");
    assert.equal(codexHook("session", codexInput({ hook_event_name: "SessionStart", cwd: p("pkg", "deep") })).code, 0);
    mkdir("pkg/deep/new");
    assert.equal(codexHook("diff", codexInput({ cwd: p("pkg", "deep") })).code, 0);
    assert.ok(exists("pkg", "deep", "new", "AGENTS.md"));
    assert.ok(exists("AGENTS.md"), "index at the git root, not in cwd");
    assert.ok(!exists("pkg", "deep", ".codex"));
  });

  test("findProjectRoot: nearest .git ancestor, else the start dir", (t) => {
    mkdir("a/b");
    const outerGit = findProjectRoot(root) !== root; // tmpdir itself inside a repo
    if (!outerGit) assert.equal(findProjectRoot(p("a", "b")), p("a", "b"));
    execFileSync("git", ["init", "-q"], { cwd: p("a") });
    assert.equal(findProjectRoot(p("a", "b")), p("a"));
  });

  test("patchTargets reads added and moved files from apply_patch input", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new/a.js\n+x\n*** Update File: b.js\n*** Move to: lib/c.js\n*** End Patch";
    assert.deepEqual(patchTargets({ command: ["apply_patch", patch] }), ["src/new/a.js", "lib/c.js"]);
    assert.deepEqual(patchTargets({ input: "*** Begin Patch\n*** Update File: b.js\n*** End Patch" }), []);
    assert.equal(patchTargets({ command: "ls" }), null);
  });

  test("apply_patch fast path: known dirs skip the scan, new dirs do not", () => {
    mkdir("src");
    run({ root, mode: "diff", input: codexInput() });
    const patch = (f) => ({ input: `*** Begin Patch\n*** Add File: ${f}\n+x\n*** End Patch` });
    assert.equal(run({ root, mode: "diff", input: codexInput({ tool_name: "apply_patch", tool_input: patch("src/a.js") }) }).fastPath, true);
    mkdir("src/feature");
    const r = run({ root, mode: "diff", input: codexInput({ tool_name: "apply_patch", tool_input: patch("src/feature/a.js") }) });
    assert.ok(!r.fastPath);
    assert.deepEqual(r.newDirs, ["src/feature"]);
  });

  test("Claude memory files are not folder content under Codex", () => {
    run({ root, mode: "diff", input: codexInput() });
    mkdir("m");
    fs.writeFileSync(p("m", "AGENTS.md"), `# m\n\n**Scopo**: x.\n\n${MANAGED_MARKER}\n`);
    fs.writeFileSync(p("m", "CLAUDE.md"), "hand-written\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(p("m", "AGENTS.md"), past, past);
    run({ root, mode: "diff", input: codexInput() });
    const stale = staleMemories(root, ["m"]);
    assert.ok(!stale.some((s) => s.unlisted.includes("CLAUDE.md")));
  });
});
