---
type: llm
focus: {source: file, path: src/routes/CLAUDE.md}
weight: 2
---
Judge the folder memory file `src/routes/CLAUDE.md` (shown as evidence).

Pass when ALL hold:
- Folder memory starts with `# src/routes`, has a one-sentence `**Scopo**:` line, and a `## File` section where each entry is `` - `name`: purpose ``.
- Descriptions are factual about the real files (users/orders handlers), no invented files, no generic advice.
- Empty sections are omitted; the file is at most 40 lines; last line is `<!-- memory-indexer:managed -->`.

Fail if the memory is still a stub, is verbose/padded.
