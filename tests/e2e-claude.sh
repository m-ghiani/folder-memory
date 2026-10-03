#!/usr/bin/env bash
# End-to-end validation with a real headless Claude Code session.
#
#   bash tests/e2e-claude.sh          # hook only: mkdir test-dir → stub + index
#   FILL=1 bash tests/e2e-claude.sh   # + Stop-driven fill, + rename keeps Stato
#   LOOKUP=1 bash tests/e2e-claude.sh # + index-first lookup on a filled fixture
#   KEEP=1 bash tests/e2e-claude.sh   # keep the temp project for inspection
#
# Costs 1 short `claude -p` run, +2 with FILL=1, +1 with LOOKUP=1.
# (`claude plugin eval` sandboxes don't load project CLAUDE.md, so lookup is tested here.)
set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/advanced-memory-e2e.XXXXXX")"
if [[ "${KEEP:-0}" == "1" ]]; then echo "workdir: $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi

pass=0; fail=0
check() { # check "<description>" <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✔ $desc"; pass=$((pass+1)); else echo "  ✖ $desc"; fail=$((fail+1)); fi
}

cd "$WORK"
git init -q
mkdir existing

echo "▶ claude plugin validate"
check "manifest valid" claude plugin validate "$PLUGIN"

echo "▶ phase 1: hook reacts to mkdir test-dir"
claude -p "Run exactly this shell command and nothing else: mkdir test-dir. Do not create or edit any file. Reply DONE." \
  --plugin-dir "$PLUGIN" \
  --allowedTools "Bash(mkdir:*)" \
  --output-format json > "$WORK/.phase1.json" 2>"$WORK/.phase1.err" || true

check "test-dir created"                         test -d test-dir
check "test-dir/CLAUDE.md created by hook"        test -f test-dir/CLAUDE.md
check "stub marker present"                       grep -q "memory-indexer:stub" test-dir/CLAUDE.md
check "root CLAUDE.md has index markers"          grep -q "dir-index:start" CLAUDE.md
check "root index has the lookup rule"            grep -q "Lookup protocol" CLAUDE.md
check "root index lists test-dir/"                grep -q '`test-dir/`' CLAUDE.md
check "root index lists pre-existing existing/"   grep -q '`existing/`' CLAUDE.md
check "no stub in pre-existing dir (baseline)"    test ! -f existing/CLAUDE.md
check "snapshot saved"                            test -f .claude/.dir-snapshot.json
check "lock released"                             test ! -f .claude/.dir-sync.lock

if [[ "${FILL:-0}" == "1" ]]; then
  echo "▶ phase 2: real task in test-dir, Stop hook makes the skill fill the stub"
  claude -p "Create the file test-dir/index.ts containing exactly: export const ok = 1; Then reply DONE." \
    --plugin-dir "$PLUGIN" \
    --allowedTools "Read" "Edit" "Write" "Bash(ls:*)" \
    --output-format json > "$WORK/.phase2.json" 2>"$WORK/.phase2.err" || true

  check "index.ts created"                        test -f test-dir/index.ts
  check "stub marker removed"                     bash -c '! grep -q "memory-indexer:stub" test-dir/CLAUDE.md'
  check "managed marker is last line"             bash -c '[ "$(tail -n1 test-dir/CLAUDE.md)" = "<!-- memory-indexer:managed -->" ]'
  check "folder memory mentions index.ts"         grep -q "index.ts" test-dir/CLAUDE.md
  check "folder memory ≤ 40 lines"                bash -c '[ "$(wc -l < test-dir/CLAUDE.md)" -le 40 ]'
  check "root TODO for test-dir replaced"         bash -c '! grep -q "\`test-dir/\`: _TODO" CLAUDE.md'

  echo "▶ phase 3: rename keeps memory byte-for-byte (except header), Stato survives"
  # Plant a sentinel in Stato (create the section if the skill omitted it).
  python3 - test-dir/CLAUDE.md <<'PY'
import sys
f = sys.argv[1]; lines = open(f).read().splitlines()
marker = lines.index("<!-- memory-indexer:managed -->")
if "## Stato" in lines:
    i = lines.index("## Stato") + 1
    lines.insert(i, "- SENTINEL-STATE: keep me")
else:
    lines[marker:marker] = ["## Stato", "- SENTINEL-STATE: keep me", ""]
open(f, "w").write("\n".join(lines) + "\n")
PY
  tail -n +2 test-dir/CLAUDE.md > "$WORK/.before-body"
  claude -p "Run exactly this shell command: mv test-dir renamed-dir. Then reply DONE." \
    --plugin-dir "$PLUGIN" \
    --allowedTools "Bash(mv:*)" "Bash(ls:*)" "Read" "Edit" \
    --output-format json > "$WORK/.phase3.json" 2>"$WORK/.phase3.err" || true

  check "renamed-dir/CLAUDE.md moved with the dir" test -f renamed-dir/CLAUDE.md
  check "header fixed to # renamed-dir"            bash -c '[ "$(head -n1 renamed-dir/CLAUDE.md)" = "# renamed-dir" ]'
  check "Stato sentinel survived"                  grep -q "SENTINEL-STATE: keep me" renamed-dir/CLAUDE.md
  check "body unchanged apart from header"         bash -c "tail -n +2 renamed-dir/CLAUDE.md | diff -q - '$WORK/.before-body'"
  check "managed marker kept"                      grep -q "memory-indexer:managed" renamed-dir/CLAUDE.md
  check "root index lists renamed-dir/"            grep -q '`renamed-dir/`' CLAUDE.md
  check "root index dropped test-dir/"             bash -c '! grep -q "\`test-dir/\`" CLAUDE.md'
  check "root description carried over (no TODO)"  bash -c '! grep -q "\`renamed-dir/\`: _TODO" CLAUDE.md'
fi

if [[ "${LOOKUP:-0}" == "1" ]]; then
  echo "▶ phase 4: lookup walks root → folder memory → file, no repo-wide search"
  mkdir "$WORK/lookup" && cd "$WORK/lookup"
  bash "$PLUGIN/tests/fixtures/lookup-project.sh"
  claude -p "Which file contains the logic that applies a discount to an invoice total? Reply with the path only. Do not modify files." \
    --plugin-dir "$PLUGIN" \
    --allowedTools "Read" "Glob" "Grep" \
    --output-format stream-json --verbose > "$WORK/.phase4.jsonl" 2>"$WORK/.phase4.err" || true
  python3 -c '
import json, sys
for l in open(sys.argv[1]):
    d = json.loads(l)
    for c in (d.get("message") or {}).get("content") or [] if d.get("type") == "assistant" else []:
        if c.get("type") == "tool_use": print(c["name"], json.dumps(c["input"]))
' "$WORK/.phase4.jsonl" > "$WORK/.phase4.tools"
  T="$WORK/.phase4.tools"

  check "answer is src/billing/invoice.ts"        grep -q 'src/billing/invoice.ts' "$WORK/.phase4.jsonl"
  check "read src/billing/CLAUDE.md"              grep -q '^Read .*billing/CLAUDE.md' "$T"
  check "no unscoped Grep/Glob"                   bash -c "! grep -E '^(Grep|Glob) ' '$T' | grep -qv '\"path\"'"
  check "catalog decoys not opened"               bash -c "! grep -q '^Read .*catalog/' '$T'"
  cd "$WORK"
fi

echo
echo "pass: $pass  fail: $fail"
[[ $fail -eq 0 ]]
