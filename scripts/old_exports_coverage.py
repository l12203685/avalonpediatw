"""Coverage check for the old workbook exports (content/_data/*.yaml, data/sheets_export/*.csv) before
deleting duplicates (Edward 2026-11-17: 「舊檔只要確認資料最新版都有包含到就可刪 (簡單說就是重複的可刪)」).

For each file it prints one Markdown table row with the rule that proves it is covered, or why it is not:

  records   a 牌譜 / 模擬瓦 export: every row that carries a record (流水號 or any record column) has its
            流水號 in the current canonical list -- games_cache.json (sheet 牌譜 tab ids) for 實戰,
            records_cache.json (M ids, the live 模擬瓦 tab) for 模擬. Rows without 流水號 must hold only
            formula columns (派5 / 派0 / 外灑) or the constant 分類. Content differences are reported
            (later corrections in the live sheet); the live version is the one kept.
  twin      a CSV whose every row (its non-empty cells, normalised) is also a row of the YAML export of
            the same tab, which stays in the repo.
  empty     no data at all (an empty list, or only '#REF!').

Run it on the tree BEFORE the deletion (the files it checks are gone afterwards):

    git checkout <commit-before-deletion> -- content/_data data/sheets_export
    python scripts/old_exports_coverage.py [repo-root]
"""

from __future__ import annotations

import collections
import csv
import json
import os
import re
import sys
import unicodedata

import yaml

FORMULA_COLS = {"派5", "派0", "外灑", "分類"}
RECORD_TABS = {"牌譜", "牌譜_backup", "Sheet70"}
SIM_TABS = {"模擬瓦", "database_sim"}


def n(v: object) -> str:
    s = unicodedata.normalize("NFKC", str("" if v is None else v)).replace("\r\n", "\n").strip()
    if re.fullmatch(r"-?\d+\.0", s):
        s = s[:-2]
    if re.fullmatch(r"-?\d+\.\d+", s):
        s = repr(round(float(s), 9))
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} 00:00:00", s):
        s = s[:10]
    return s


def rows_of(path: str) -> list[dict]:
    if path.endswith(".yaml"):
        with open(path, encoding="utf-8") as f:
            d = yaml.safe_load(f)
        if isinstance(d, dict):
            raise ValueError("not a sheet export")  # metadata (_parse_summary) / manifests: never "empty"
        return d if isinstance(d, list) else []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def tuples_of(path: str) -> list[tuple]:
    if path.endswith(".yaml"):
        data = rows_of(path)
        out = [tuple(x for x in map(n, data[0].keys()) if x)] if data and isinstance(data[0], dict) else []
        out += [tuple(x for x in map(n, r.values()) if x) for r in data if isinstance(r, dict)]
    else:
        with open(path, encoding="utf-8-sig", newline="") as f:
            out = [tuple(x for x in map(n, r) if x) for r in csv.reader(f)]
    return [t for t in out if t]


CODE_EXT = (".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".yml", ".yaml", ".json", ".sh")
SKIP_DIRS = ("content/_data/", "data/sheets_export/", "avalon-game-platform/")


def code_files(root: str) -> list[str]:
    import subprocess
    out = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True).stdout.decode()
    return [f for f in out.split("\0") if f.endswith(CODE_EXT) and not f.startswith(SKIP_DIRS)]


def readers(root: str, rel: str, files: list[str]) -> list[str]:
    """Code files that mention this export by file name (comments included: a mention means someone may read it)."""
    base = os.path.basename(rel)
    hits = []
    for f in files:
        try:
            text = open(os.path.join(root, f), encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if base in text:
            hits.append(f)
    return hits


def records_cov(path: str, ids: set[str], latest: dict[str, list] | None, col: dict[str, int]) -> tuple[bool, str]:
    data = rows_of(path)
    with_id = [r for r in data if n(r.get("流水號"))]
    loose = [r for r in data if not n(r.get("流水號")) and any(n(v) for k, v in r.items() if k not in FORMULA_COLS)]
    present = [r for r in with_id if n(r["流水號"]) in ids]
    same = None
    if latest is not None:
        cols = [c for c in ("文字記錄", "配置", "刺殺", "結果") if c in col]
        same = sum(1 for r in present if all(n(r.get(c)) == n(latest[n(r["流水號"])][col[c]]) for c in cols if c in r))
    ok = bool(with_id) and len(present) == len(with_id) and not loose
    detail = f"{len(present)}/{len(with_id)} 局的流水號在現行資料裡"
    if same is not None:
        detail += f"（內容完全相同 {same}，其餘是試算表後來改正過的版本）"
    if loose:
        detail += f"；另有 {len(loose)} 列沒有流水號卻有牌譜內容"
    return ok, detail


def main(root: str = ".") -> int:
    srv = os.path.join(root, "packages", "server")
    games = json.load(open(os.path.join(srv, "games_cache.json"), encoding="utf-8"))
    fi = {k: i for i, k in enumerate(games["fields"])}
    sheet_ids = {str(r[fi["id"]]) for r in games["games"] if r[fi["src"]] == 0}
    posts = json.load(open(os.path.join(srv, "records_cache.json"), encoding="utf-8"))["posts"]
    sim_ids = {p["id"][1:] for p in posts if p["id"].startswith("M")}
    snap = json.load(open(os.path.join(srv, "sheets_cache.json"), encoding="utf-8"))["牌譜"]
    col = {h: i for i, h in enumerate(snap[0])}
    latest = {n(r[col["流水號"]]): r for r in snap[1:] if n(r[col["流水號"]])}

    files = sorted(f"content/_data/{b}" for b in os.listdir(os.path.join(root, "content/_data")) if b.endswith(".yaml"))
    files += sorted(f"data/sheets_export/{b}" for b in os.listdir(os.path.join(root, "data/sheets_export")) if b.endswith(".csv"))
    code = code_files(root)
    print("| 檔案 | 判斷 | 依據 | 有程式提到 | 刪 |")
    print("|---|---|---|---|---|")
    for rel in files:
        path = os.path.join(root, rel)
        tab = os.path.basename(rel).rsplit(".", 1)[0].replace("阿瓦隆百科_", "").replace("阿瓦隆百科機器人_", "機器人_")
        if tab == "個人資料卡":
            print(f"| `{rel}` | 不處理 | 站長另外決定 | — | 否 |")
            continue
        if tab in RECORD_TABS:
            ok, why = records_cov(path, sheet_ids, latest, col)
            kind = "records（實戰，對 games_cache.json）"
        elif tab in SIM_TABS:
            ok, why = records_cov(path, sim_ids, None, col)
            kind = "records（模擬，對 records_cache.json 的 M）"
        else:
            try:
                cells = [x for t in tuples_of(path) for x in t]
            except ValueError:
                cells = None
            if cells is None:
                ok, kind, why = False, "—", "不是分頁匯出（說明檔或清單）"
            elif not cells or set(cells) <= {"#REF!"}:
                ok, why, kind = True, "沒有資料（空的或只有 #REF!）", "empty"
            elif rel.endswith(".csv") and os.path.exists(os.path.join(root, f"content/_data/{tab}.yaml")):
                yt = collections.Counter(tuples_of(os.path.join(root, f"content/_data/{tab}.yaml")))
                ct = tuples_of(path)
                miss = sum(1 for t in ct if t not in yt)
                ok, kind = miss == 0, "twin（同一分頁的 YAML，留在 repo）"
                why = f"{len(ct) - miss}/{len(ct)} 列在 YAML 裡逐列相同"
            else:
                ok, kind, why = False, "—", "沒有可以逐列比對的現行來源"
        who = readers(root, rel, code)
        delete = ok and not who
        print(f"| `{rel}` | {kind} | {why} | {'、'.join(f'`{w}`' for w in who) or '沒有'} | {'是' if delete else '否'} |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
