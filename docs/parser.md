# Master Excel Parser — Editor & Dev Guide

The site's game data (roles, rules, leaderboards, career stats, synergy
matrices, game records) lives in one human-authored Excel workbook:
`阿瓦隆百科.xlsx`. The parser at `scripts/parse_master.py` converts each
sheet into a YAML file under `content/_data/` for downstream Astro Content
Collections (see `content/schemas/index.ts`).

This is a **local authoring tool**. The xlsx source is **not** committed to
the repo. CI validates the committed YAML; it does not re-run the parser.

## Editor workflow

1. Open `阿瓦隆百科.xlsx` and edit as usual.
2. Save the file.
3. Run the parser (see below).
4. `git diff content/_data/` to review generated changes.
5. Commit both the YAML and any schema tweaks together.

## Running the parser

### Option A — environment variable (recommended)

Put the xlsx anywhere you like and set:

```bash
export AVALON_MASTER_XLSX="C:/path/to/阿瓦隆百科.xlsx"   # bash / WSL
setx  AVALON_MASTER_XLSX "C:\path\to\阿瓦隆百科.xlsx"   # Windows persistent

python scripts/parse_master.py --output content/_data/
```

### Option B — explicit CLI flag

```bash
python scripts/parse_master.py \
  --input  "C:/path/to/阿瓦隆百科.xlsx" \
  --output content/_data/
```

### Option C — staged path

Drop the workbook at `data/master.xlsx` (gitignored). The parser will
pick it up automatically when no `--input` / env var is set.

### Resolution order

1. `--input PATH` CLI flag
2. `$AVALON_MASTER_XLSX`
3. `data/master.xlsx`
4. Legacy authoring paths (`E:/阿瓦隆百科/阿瓦隆百科.xlsx`, …) — only if they exist

## Flags

| Flag | Purpose |
|------|---------|
| `--input PATH` | Override source xlsx |
| `--output DIR` | Output directory (default `content/_data/`) |
| `--verbose` / `-v` | Show per-sheet debug lines (merged-cell ranges, etc.) |
| `--no-merge-fill` | Skip the openpyxl merged-cell unmerge pass (faster on flaky workbooks) |

## Output layout

- `content/_data/<sheet>.yaml` — one YAML file per sheet
- `content/_data/_parse_summary.yaml` — manifest: source, `generated_at` (+08), per-sheet `{rows, skipped, header_cols, bytes}`
- Special-sheet aliases (`SPECIAL_SHEETS` in the parser):
  - `角色*` → `roles.yaml`
  - `陣容*` → `team_composition.yaml`
  - `*規則*` → `rules.yaml` (first match wins)

## Schemas

Astro Content Collection schemas (Zod) live in `content/schemas/index.ts`
and map output filenames → shape contracts. They're `.passthrough()` by
default so new columns don't break the build. Tighten per-sheet when a
downstream page depends on a specific column.

`content/config.ts` is staged for the future Astro package; copy it into
`packages/<astro-app>/src/content/config.ts` when Astro lands.

## Tests

```bash
pip install -r scripts/requirements-parser.txt
cd scripts
pytest -v
```

Current suite (14 tests):

- 11 unit tests on normalization / header dedupe / CJK filenames / YAML round-trip
- `test_main_end_to_end` — synthesizes a 4-sheet fixture xlsx (roles / rules / career / empty), runs `main()`, asserts the 3 happy-path sheets and the empty-sheet edge case
- `test_env_var_drives_default_input` — confirms `$AVALON_MASTER_XLSX` is the default
- `test_main_missing_input_returns_2` — confirms exit code 2 when no xlsx is resolvable

## CI

`.github/workflows/parser.yml` runs on PRs that touch the parser, its
tests, or `content/_data/**`:

1. **pytest parser** — installs `requirements-parser.txt`, runs the suite
2. **validate-yaml** — loads every `content/_data/*.yaml` with PyYAML and
   fails if any file is malformed

CI does **not** re-run the parser against a real xlsx; the xlsx is not
committed. Authors regenerate YAML locally and commit the snapshot.

## Known quirks

- **openpyxl + Python 3.14 pivot-cache bug** — workbook has pivot tables;
  parser uses pandas for the main read and falls back gracefully if the
  openpyxl merged-cell pass fails.
- **Large sheets** — `牌譜` is ~3 MB YAML. Fine for build-time; if it grows,
  consider splitting or gitignoring and regenerating on demand.
- **Duplicate headers** — deduped via `_N` suffix (`unique_headers`).
- **Int vs string** — Excel cell types sometimes flip between int and
  string on manual re-entry; downstream code should not depend on the
  concrete type of a numeric-ish column.

## Source-of-truth decision (from M0.3 spike)

Option **C** — YAML is committed, xlsx stays off-repo, parser is a local
authoring tool. Option A (commit sanitized xlsx) and B (Google Drive pull)
remain available if the editor workflow outgrows local file handoff.
