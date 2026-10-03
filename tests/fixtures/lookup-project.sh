#!/usr/bin/env bash
# Fixture: a project whose CLAUDE.md index is already filled.
set -euo pipefail
mkdir -p src/billing src/auth src/catalog
cat > CLAUDE.md <<'MD'
# shop

<!-- dir-index:start -->
## Directory
**Lookup protocol (mandatory, before any Grep/Glob):** this index and each folder's `CLAUDE.md` map the codebase. Match the request to a folder below, `Read` its `CLAUDE.md`, follow **Sottocartelle** down, open only the files it names. Search with Grep/Glob only when the index has no match, scoped to the closest folder.

- `src/`: codice applicativo (billing, auth, catalogo prodotti)
<!-- dir-index:end -->
MD
cat > src/CLAUDE.md <<'MD'
# src

**Scopo**: codice applicativo del negozio.

## Sottocartelle
- `billing/`: fatture e pagamenti (sconti, IVA, totali)
- `auth/`: login e sessioni (JWT, password)
- `catalog/`: prodotti e prezzi di listino

<!-- memory-indexer:managed -->
MD
cat > src/billing/CLAUDE.md <<'MD'
# src/billing

**Scopo**: calcolo fatture.

## File
- `invoice.ts`: totale fattura (`invoiceTotal`), applica sconti (`applyDiscount`)
- `vat.ts`: aliquote IVA (`vatRate`)

<!-- memory-indexer:managed -->
MD
printf 'export const applyDiscount = (t: number, pct: number) => t * (1 - pct / 100);\nexport const invoiceTotal = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' > src/billing/invoice.ts
printf 'export const vatRate = 22;\n' > src/billing/vat.ts
for f in discount-banner promo price; do printf '// discount UI copy, not logic\nexport const %s = "discount";\n' "${f//-/_}" > "src/catalog/$f.ts"; done
printf 'export const login = () => {};\n' > src/auth/login.ts
