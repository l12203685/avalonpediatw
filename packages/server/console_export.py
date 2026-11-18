"""
主控台匯出（牌譜這一半）：從這份 checkout 的 game_db.json 與它的來源檔，寫出主控台「問題牌譜」分頁和
「牌譜數量」要的兩個檔。repo main 是唯一來源，主控台只是鏡像（docs/CONSOLE.md）。

  problem_games.json  問題牌譜清單：每一局的 id、分組（excluded／error／conflict／dup／stuck）、問題、規則、
                      細節、選項、網站連結、來源標籤；records = 每一局（含 pair 的另一局）每個來源各自的
                      DC 牌譜格式文字，試算表來源另附試算表的原文。
  game_counts.json    依種類／狀態的局數、錯誤局、問題分組的數量、主控台的「要注意」計數，dbVersion = git SHA。
  name_collisions.json 同名不同人的候選（name_collisions.py：同一局兩個座位同名、同一天同場次兩桌、兩群沒有共同牌友），
                      每筆附主控台 nameSplits/<id> 的建議文件。這個檔的內容就是名字，一律只給私人主控台。

分組規則照 2026-11-17 主控台第一版的整理腳本（make_rows.py）移植：
  1. excluded  錯誤局（刺客刺到隊友、尾派沒出任務；build 的 excluded）
  2. error     總庫狀態是 error 的局
  3. conflict  有 CONFLICT 的局（前面沒列過的）
  4. dup       有 NEAR_DUP 或 DUP_SAME_SOURCE 的局（前面沒列過的）
  5. stuck     讀不懂的試算表局：一個任務前有 6 次以上的提議（第 N、N+1 局可能黏在一起），且原文看不出尾派沒出任務
跟舊腳本不同的地方（刻意的）：
  - 不再寫死「已經在 decisions 的三局」：站長的裁定進了 game_db_corrections.json，重建之後那幾局本來就不會再列出。
  - 來源不一致的投票細節用來源的公開 id 找來源（舊腳本對模擬瓦／ProAvalon 來源找不到，只寫「投票不一樣」）。
  - 不帶主控台自己的狀態欄（answer、status、updatedAt…）：那些是主控台 db 的資料，匯出只給內容。
  - 列的順序固定為（分組、日期、id），重跑結果一字不差。

隱私：problem_games.json 預設不輸出任何玩家名字。--names 才在 records 加上每個座位的暱稱（試算表＝牌譜分頁的玩1…玩0；
Discord／模擬瓦＝records_cache 的 names），只給私人主控台用；輸出資料夾要在 repo 外面。

Usage:  python console_export.py --out <dir> [--srv <packages/server>] [--sha <git sha>] [--now <ISO time>] [--names]
                                [--with-proavalon]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import game_db as G  # noqa: E402
import name_collisions as NC  # noqa: E402
import voting_stats as vs  # noqa: E402

SITE_RECORDS = "https://avalon-game-platform.web.app/#records="
GROUPS = ("excluded", "error", "conflict", "dup", "stuck")
GROUP_LABELS = {"excluded": "錯誤局（不記錄）", "error": "規則錯誤", "conflict": "來源不一致", "dup": "疑似重複", "stuck": "可能兩局黏在一起"}
SEATS = "1234567890"
RECORD_LABEL = {G.SRC_SHEET: "試算表", G.SRC_IMPORT: "試算表 Discord匯入", G.SRC_DISCORD: "Discord",
                G.SRC_SIM: "試算表 模擬瓦", G.SRC_PROAVALON: "ProAvalon"}
SOURCE_LABEL = {G.SRC_SHEET: "試算表", G.SRC_DISCORD: "Discord", G.SRC_IMPORT: "Discord匯入", G.SRC_SIM: "模擬瓦"}
SEAT_RE = re.compile(r"隊伍 ([0-9]{3,5})")
FIELD = re.compile(r"(結果|刺殺|日期|線上／面對面|湖中女神|投票)(?:（([^（）]*)）)?")


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def load_inputs(srv: Path, with_proavalon: bool | None = None) -> dict[str, Any]:
    """Everything the export reads, from one packages/server directory (no network, no credentials). ProAvalon
    follows game_db.py: off by default since 2026-11-18 (G.INCLUDE_PROAVALON), on with --with-proavalon."""
    if with_proavalon is None:
        with_proavalon = getattr(G, "INCLUDE_PROAVALON", True)
    load = lambda name: G.load_json(srv / name)  # noqa: E731
    db = load("game_db.json")
    games_doc, records_doc = load("games_cache.json"), load("records_cache.json")
    if not db or not games_doc or not records_doc:
        missing = [n for n, d in (("game_db.json", db), ("games_cache.json", games_doc), ("records_cache.json", records_doc)) if not d]
        raise SystemExit(f"console_export: {'、'.join(missing)} missing or empty in {srv}")
    snapshot = load("sheets_cache.json")
    texts = G.snapshot_texts(snapshot)
    sources = G.dataset_sources(games_doc, texts)
    sources += G.records_sources(records_doc)[0]
    sources += G.proavalon_sources(load("proavalon_games.json") if with_proavalon else None)
    G.apply_corrections(sources, load("game_db_corrections.json"))
    excluded: list[dict[str, Any]] = []
    rebuilt = G.build(sources, excluded)
    return {"db": db, "sources": sources, "texts": texts, "excluded": excluded, "rebuilt": rebuilt,
            "snapshot": snapshot, "records_doc": records_doc, "games_doc": games_doc}


# ---------------------------------------------------------------------------
# Problem rows (port of make_rows.py)
# ---------------------------------------------------------------------------

def seats(t: Sequence[str] | str) -> str:
    return "、".join(t) + "家"


def plain(msg: str) -> str:
    return SEAT_RE.sub(lambda m: f"隊伍（{seats(m.group(1))}）", msg).replace("） 上", "）上")


def rule_name(rule: str) -> str:
    return G.RULES[rule][1].split("（")[0]


def src_label(row: Mapping[str, Any]) -> str:
    return "、".join(f"{SOURCE_LABEL[s['src']]} {s['id']}" if s["src"] in SOURCE_LABEL else s["id"] for s in row["sources"])


def per_round(text: str) -> tuple[list[tuple[int, int]], int]:
    """(proposals before the mission, mission size) per mission line of a sheet's raw 文字記錄, and the proposals
    after the last mission."""
    sizes: list[tuple[int, int]] = []
    pending = 0
    for raw in (text or "").splitlines():
        line = " ".join(unicodedata.normalize("NFKC", raw).translate(vs._SYMBOLS).strip().strip("`*_~|").split())
        if re.fullmatch(r"[oxOX](?: ?[oxOX]){0,4}", line):
            mission = line.replace(" ", "")
        else:
            m = vs._PROPOSAL.fullmatch(line)
            if not m:
                continue
            pending += 1
            mission = m.group(4) or ""
        if mission:
            sizes.append((pending, len(mission)))
            pending = 0
    return sizes, pending


def _row(gid: str, group: str, kind: str, date: str, venue: str, problem: str, options: list[str], link: bool = True,
         **extra: Any) -> dict[str, Any]:
    d: dict[str, Any] = {"id": gid, "group": group, "kind": kind, "date": date or "", "venue": venue or "",
                         "problem": problem, "options": options, "link": SITE_RECORDS + gid if link else ""}
    d.update(extra)
    return d


def _checks(row: Mapping[str, Any], rule: str) -> list[Mapping[str, Any]]:
    return [c for c in row["checks"] if c["rule"] == rule]


def _vote_detail(row: Mapping[str, Any], by_pub: Mapping[str, dict[str, Any]], label_other: str) -> list[str]:
    """Which seats the two sources record differently for each differing proposal."""
    srcs = [by_pub.get(x["id"]) for x in row["sources"]]
    srcs = [s for s in srcs if s and s.get("game")]
    if len(srcs) < 2:
        return []
    srcs.sort(key=lambda s: G.SOURCE_PRIORITY.index(s["src"]))
    a, b = srcs[0], srcs[1]
    out = []
    for (r, k, x), (_, _, y) in zip(G.proposal_votes(a["game"]), G.proposal_votes(b["game"])):
        if x != y:
            only_a, only_b = sorted(x - y), sorted(y - x)
            bits = []
            if only_a:
                bits.append(f"{seats(only_a)}：試算表記贊成、{label_other} 記反對")
            if only_b:
                bits.append(f"{seats(only_b)}：{label_other} 記贊成、試算表記反對")
            out.append(f"第 {r} 局第 {k} 次提議 " + "；".join(bits))
    return out


def problem_rows(games: Sequence[Mapping[str, Any]], excluded: Sequence[Mapping[str, Any]],
                 sources: Sequence[dict[str, Any]], texts: Mapping[str, str]) -> list[dict[str, Any]]:
    """The console's 問題牌譜 list. games = game_db.json games; excluded/sources = what game_db.build saw."""
    by_pub = {G.public_id(s): s for s in sources}
    docs: dict[str, dict[str, Any]] = {}

    # 1. excluded --------------------------------------------------------------
    for e in excluded:
        parts = []
        for sid in e["sources"]:
            s = by_pub.get(sid)
            if not s:
                continue
            if s.get("game"):
                for c in G.validate(s["game"], partial=e["kind"] == G.KIND_SIM):
                    if c["rule"] in G.EXCLUDE_RULES:
                        parts.append(plain(c["msg"]))
            if s.get("forced_rounds") and s["src"] == G.SRC_SHEET:
                sizes, pending = per_round(texts.get(s["id"], ""))
                for r in s["forced_rounds"]:
                    if r <= len(sizes):
                        parts.append(f"第 {r} 局有 {sizes[r - 1][0]} 次提議（第 5 次提議沒有出任務）")
                    else:
                        parts.append(f"紀錄停在第 {r} 局第 {pending} 次提議，沒有任務結果")
        why = "、".join(rule_name(r) for r in e["rules"])
        if "ASSASSIN_TEAMMATE" in e["rules"]:
            why = "刺客刺到隊友"
        elif "FORCED_NOT_RUN" in e["rules"]:
            why = "尾派（第 5 次提議）沒有出任務"
        ext = bool(e.get("external"))
        docs[e["id"]] = _row(
            e["id"], "excluded", "external" if ext else e["kind"], e["date"], "", why,
            ["確認排除", "其實沒錯（我寫在下面）"], link=not ext,
            detail="；".join(dict.fromkeys(parts)), rules=list(e["rules"]),
            sourceLabel="ProAvalon（外部）" if ext else "、".join(e["sources"]),
        )

    ours = [g for g in games if not g.get("external")]

    # 2. errors -----------------------------------------------------------------
    for g in ours:
        if g["status"] != "error":
            continue
        errs = [c for c in g["checks"] if c["level"] == "error"]
        rules = list(dict.fromkeys(c["rule"] for c in errs))
        others = ["另外疑似同一局：" + c["msg"] for c in _checks(g, "NEAR_DUP")]
        others += ["另外來源不一致：" + c["msg"] for c in _checks(g, "CONFLICT")]
        docs[g["id"]] = _row(
            g["id"], "error", g["kind"], g["date"], g.get("venue", ""), "、".join(rule_name(r) for r in rules),
            ["我在來源改好了", "正確的寫在下面", "這局不要記"],
            detail="；".join(plain(c["msg"]) for c in errs), rules=rules, note="；".join(others), sourceLabel=src_label(g),
        )

    # 3. conflicts ----------------------------------------------------------------
    for g in ours:
        cs = _checks(g, "CONFLICT")
        if not cs or g["id"] in docs:
            continue
        vals_a, vals_b, kinds, detail = [], [], [], []
        for c in cs:
            m = re.match(r"(.+?) 跟 (.+?)（(.+?)）不一樣：(.*)", c["msg"])
            if not m:
                detail.append(c["msg"])
                continue
            _, lb, _, rest = m.groups()
            lb_short = "Discord" if "Discord" in lb else lb
            for f, v in FIELD.findall(rest):
                kinds.append(f)
                if f in ("結果", "刺殺", "日期", "線上／面對面") and " / " in v:
                    x, y = v.split(" / ", 1)
                    if f == "刺殺":
                        x, y = x + "家", y + "家"
                    vals_a.append(f"{f} {x}")
                    vals_b.append(f"{f} {y}")
                    detail.append(f"{f}：試算表記 {x}，{lb_short} 記 {y}")
                elif f == "投票":
                    detail += _vote_detail(g, by_pub, lb_short) or [f"投票不一樣：{v}"]
                elif f == "湖中女神":
                    detail.append("湖中女神的紀錄不一樣")
        a_txt, b_txt = "、".join(vals_a), "、".join(vals_b)
        docs[g["id"]] = _row(
            g["id"], "conflict", g["kind"], g["date"], g.get("venue", ""),
            "兩個來源記的" + "、".join(dict.fromkeys(kinds)) + "不一樣",
            [f"試算表對（{a_txt}）" if a_txt else "試算表對", f"Discord 對（{b_txt}）" if b_txt else "Discord 對", "都不對（我寫在下面）"],
            detail="；".join(detail), sourceLabel=src_label(g),
        )

    # 4. near dup / dup same source ---------------------------------------------------
    for g in ours:
        nd, dd = _checks(g, "NEAR_DUP"), _checks(g, "DUP_SAME_SOURCE")
        if not (nd or dd) or g["id"] in docs:
            continue
        if nd:
            detail = []
            for c in nd:
                other = c["msg"].split("還有 ")[-1]
                where = ""
                if other in docs and docs[other]["group"] in ("error", "conflict"):
                    where = f"（{other} 列在「{GROUP_LABELS[docs[other]['group']]}」）"
                detail.append(f"同一天、同配置的還有 {other}，但派隊或任務不一樣{where}")
            problem, pair = "疑似跟另一局是同一局", nd[0]["msg"].split("還有 ")[-1]
            opts = ["是同一局，以這筆為準", "是同一局，以另一筆為準", "是兩局，都留著"]
        else:
            detail, pair = [c["msg"] for c in dd], ""
            problem = "同一局在 Discord 貼了兩次"
            opts = ["是同一局重複貼，刪一篇", "是兩局（我寫在下面）"]
        docs[g["id"]] = _row(g["id"], "dup", g["kind"], g["date"], g.get("venue", ""), problem, opts,
                             detail="；".join(detail), pair=pair, sourceLabel=src_label(g))

    # 5. 6+ proposals before one mission (unreadable sheet rows; not excluded) ---------------
    for g in ours:
        if g["status"] != "unreadable" or g["id"] in docs:
            continue
        sheet = [s for s in g["sources"] if s["src"] == G.SRC_SHEET]
        if not sheet:
            continue
        text = texts.get(sheet[0]["id"][1:], "")
        sizes, _ = per_round(text)
        big = [(i, n, sz) for i, (n, sz) in enumerate(sizes, 1) if n > G.FORCED_ATTEMPT]
        if not big or G.raw_forced_rounds(text):
            continue
        i, n, sz = big[0]
        want = G.TEAM_SIZES[i - 1] if i <= len(G.TEAM_SIZES) else None
        det = f"試算表的文字記錄在第 {i} 個任務結果前有 {n} 次提議，那個任務是 {sz} 張"
        if want and want != sz:
            det += f"（第 {i} 局應該是 {want} 張、第 {i + 1} 局才是 {sz} 張），看起來第 {i} 局的任務沒記、跟第 {i + 1} 局接在一起"
        det += f"；整份只記了 {len(sizes)} 個任務結果"
        docs[g["id"]] = _row(
            g["id"], "stuck", g["kind"], g["date"], g.get("venue", ""),
            f"第 {i} 局記了 {n} 次提議，可能是第 {i}、{i + 1} 局黏在一起",
            ["是兩局黏在一起（我在來源改好了）", "紀錄沒錯（我寫在下面）", "這局不要記"],
            detail=det, sourceLabel=src_label(g),
        )

    return sorted(docs.values(), key=lambda d: (GROUPS.index(d["group"]), d["date"], d["id"]))


# ---------------------------------------------------------------------------
# Per-source records (port of make_problem_records.py)
# ---------------------------------------------------------------------------

def _marks(votes: Sequence[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for tok in votes:
        for m in re.finditer(r"([0-9]+)([+-])", tok):
            for s in m.group(1):
                out[s] = m.group(2)
    return out


def _proposal_line(p: Mapping[str, Any], attempt: int) -> str:
    team, votes = p["team"], p.get("votes") or []
    if attempt == 4 and not votes:
        return team
    mk = _marks(votes)
    v = {s: mk.get(s, "+" if s in team else "-") for s in SEATS}
    black = "".join(s for s in SEATS if s in team and v[s] == "-")
    white = "".join(s for s in SEATS if s not in team and v[s] == "+")
    return " ".join(x for x in (team, black and black + "-", white and white + "+") if x)


def records_text(game: Mapping[str, Any]) -> str:
    """A parsed game as DC 牌譜格式 text (seats and marks only)."""
    lakes = {lk["after"]: lk for lk in game.get("lakes", [])}
    lines = []
    for i, rnd in enumerate(game.get("rounds", [])):
        for a, p in enumerate(rnd["proposals"]):
            lines.append(_proposal_line(p, a))
        if rnd.get("mission"):
            lines.append(rnd["mission"])
        lk = lakes.get(i + 1)
        if lk:
            lines.append(f"{lk['holder']}>{lk['target']}" + (f" {lk['claim']}" if lk.get("claim") else ""))
    lines.append(game.get("config", ""))
    lines.append("刺客刺殺:" + ("" if game.get("outcome") == "三紅" else (game.get("assassination") or "")))
    lines.append("結果:" + (game.get("outcome") or ""))
    return "\n".join(lines)


class SheetRows:
    """The 牌譜 tab of sheets_cache.json, by 流水號."""

    def __init__(self, snapshot: Any) -> None:
        tab = (snapshot or {}).get("牌譜") or [[]]
        header, *rows = tab
        self.col = {h: i for i, h in enumerate(header)}
        k = self.col.get("流水號")
        self.rows = {r[k].strip(): r for r in rows if k is not None and len(r) > k and r[k].strip()}

    def get(self, sid: str, name: str) -> str:
        r = self.rows.get(sid)
        i = self.col.get(name)
        return r[i].strip() if r is not None and i is not None and len(r) > i else ""

    def has(self, sid: str) -> bool:
        return sid in self.rows


def _raw_of(s: Mapping[str, Any], texts: Mapping[str, str], sheet: SheetRows) -> str | None:
    if s["src"] != G.SRC_SHEET or s["id"] not in texts:
        return None
    lines = [ln.rstrip() for ln in texts[s["id"]].replace("\r\n", "\n").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    if sheet.has(s["id"]):
        lines += [sheet.get(s["id"], "配置"), "刺客刺殺:" + sheet.get(s["id"], "刺殺"), "結果:" + sheet.get(s["id"], "結果")]
    return "\n".join(lines)


def source_clusters(sources: Sequence[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """public id -> every source of the same game (same fingerprint and type), in SOURCE_PRIORITY order."""
    clusters: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for s in sources:
        group = G.KIND_SIM if s["kind"] == G.KIND_SIM else G.KIND_REAL
        key = (group, s["fp"]) if s["game"] and s["fp"] else ("single", G.public_id(s), id(s))
        clusters[key].append(s)
    rank = {src: i for i, src in enumerate(G.SOURCE_PRIORITY)}
    by_pid: dict[str, list[dict[str, Any]]] = {}
    for members in clusters.values():
        members.sort(key=lambda s: (rank[s["src"]], s["id"]))
        for s in members:
            by_pid.setdefault(G.public_id(s), members)
    return by_pid


def source_records(gid: str, by_pid: Mapping[str, list[dict[str, Any]]], texts: Mapping[str, str], sheet: SheetRows,
                   names_of=None) -> list[dict[str, Any]] | None:
    members = by_pid.get(gid)
    if not members:
        return None
    out = []
    for s in members:
        pid = G.public_id(s)
        e: dict[str, Any] = {"id": pid, "label": f"{RECORD_LABEL[s['src']]} {pid}", "date": s["date"], "venue": s["venue"]}
        if s["game"]:
            e["text"] = records_text(s["game"])
        else:
            e["problem"] = s.get("problem") or "讀不懂"
        if names_of is not None:
            e.update(names_of(s))
        raw = _raw_of(s, texts, sheet)
        if raw:
            e["raw"] = raw
        if s.get("corrected"):
            e["corrected"] = True
        out.append(e)
    return out


def seat_names(inputs: Mapping[str, Any], srv: Path):
    """--names: a function source -> {"names": [10 seat nicknames], "namesRaw": {seat index: as written}} using the
    owner's alias file. Private console only; never called by the tests or by default."""
    import generate_cache as gc  # noqa: PLC0415
    aliases = gc.load_player_aliases(srv / "player_aliases.json", show_names=True)
    sheet = SheetRows(inputs["snapshot"])
    post_names = {str(p.get("id")): (p.get("game") or {}).get("names")
                  for p in inputs["records_doc"].get("posts", []) if (p.get("game") or {}).get("names")}

    def resolve(name: str) -> tuple[str, str]:
        raw = gc.normalize_player_name(name or "")
        if not raw:
            return "", ""
        off = aliases.official.get(aliases.keys.get(gc.player_name_key(raw), ""), "")
        return (off, raw) if off and off != raw else (raw, "")

    def names_of(s: Mapping[str, Any]) -> dict[str, Any]:
        if s["src"] == G.SRC_SHEET:
            nm = [sheet.get(s["id"], "玩" + k) for k in SEATS] if sheet.has(s["id"]) else None
        elif s["src"] in (G.SRC_DISCORD, G.SRC_SIM):
            nm = post_names.get(G.public_id(s))
        else:
            nm = None
        if not nm:
            return {}
        pairs = [resolve(n) for n in list(nm)[:10]] + [("", "")] * max(0, 10 - len(nm))
        out: dict[str, Any] = {"names": [a for a, _ in pairs]}
        orig = {str(i): b for i, (_, b) in enumerate(pairs) if b}
        if orig:
            out["namesRaw"] = orig
        return out

    return names_of


def problem_records(rows: Sequence[Mapping[str, Any]], sources: Sequence[dict[str, Any]], texts: Mapping[str, str],
                    snapshot: Any, names_of=None) -> tuple[dict[str, Any], list[str]]:
    """id -> {"sources": [...], "pair"?} for every problem game and the other game of each pair."""
    by_pid = source_clusters(sources)
    sheet = SheetRows(snapshot)
    result: dict[str, Any] = {}
    missing: list[str] = []
    for d in rows:
        recs = source_records(d["id"], by_pid, texts, sheet, names_of)
        if recs is None:
            missing.append(d["id"])
            continue
        e: dict[str, Any] = {"sources": recs}
        if d.get("pair"):
            e["pair"] = d["pair"]
            if d["pair"] not in result:
                pr = source_records(d["pair"], by_pid, texts, sheet, names_of)
                if pr is not None:
                    result[d["pair"]] = {"sources": pr}
        result[d["id"]] = e
    return dict(sorted(result.items())), missing


# ---------------------------------------------------------------------------
# Counts
# ---------------------------------------------------------------------------

def game_counts(db: Mapping[str, Any], rows: Sequence[Mapping[str, Any]], sha: str, now: str,
                in_sync: bool) -> dict[str, Any]:
    ours = [g for g in db["games"] if not g.get("external")]

    def n_games(pred, kinds=(G.KIND_REAL,)) -> int:
        return sum(1 for g in ours if g["kind"] in kinds and pred(g))

    has = lambda rule: (lambda g: any(c["rule"] == rule for c in g["checks"]))  # noqa: E731
    unread = Counter(g.get("problem", "") for g in ours if g["status"] == "unreadable" and g["kind"] != G.KIND_SIM)
    c = db.get("counts", {})
    return {
        "format": "console-game-counts",
        "dbVersion": sha,
        "updatedAt": now,
        # game_db.json 跟這份 checkout 的來源重建出來的一樣（不一樣＝來源改了、總庫還沒重建）
        "gameDbInSync": in_sync,
        "games": c.get("games", len(db["games"])),
        "byKind": c.get("byKind", {}),
        "byStatus": c.get("byStatus", {}),
        "excluded": c.get("excluded", {}),
        "problems": {g: sum(1 for r in rows if r["group"] == g) for g in GROUPS},
        "items": [
            {"label": "讀不懂的實戰局", "n": n_games(lambda g: g["status"] == "unreadable", (G.KIND_REAL, G.KIND_BOT)),
             "note": "最多的原因：" + "、".join(f"{k} {v}" for k, v in unread.most_common(3))},
            {"label": "讀不懂的模擬局", "n": n_games(lambda g: g["status"] == "unreadable", (G.KIND_SIM,))},
            {"label": "推定全開白的局", "n": n_games(lambda g: bool(g.get("inferred_votes"))),
             "note": "上一局成功、這局第 1 次提議順著派、紀錄沒寫投票，推定 10 人全投白"},
            {"label": "投票張數跟提議過不過對不上", "n": n_games(has("VOTE_RESULT")), "note": "多半是漏記了場外白／場內黑"},
            {"label": "投票記號跟隊伍對不上", "n": n_games(has("VOTE_MARKS"), (G.KIND_REAL, G.KIND_BOT, G.KIND_SIM)),
             "note": "多半是座位寫錯（含模擬局）"},
            {"label": "三藍卻沒記刺殺目標", "n": n_games(has("ASSASSIN_MISSING"))},
            {"label": "試算表 note 標了要注意", "n": n_games(has("OWNER_FLAG"))},
            {"label": "沒有日期", "n": n_games(has("NO_DATE"))},
        ],
    }


def db_in_sync(db: Mapping[str, Any], rebuilt: Sequence[Mapping[str, Any]]) -> bool:
    key = lambda rows: sorted((r["id"], r["status"], len(r["checks"])) for r in rows)  # noqa: E731
    return key(db["games"]) == key(rebuilt)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def dump(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def export(srv: Path, out: Path, sha: str, now: str, names: bool = False,
           with_proavalon: bool | None = None) -> dict[str, Any]:
    inputs = load_inputs(srv, with_proavalon)
    db = inputs["db"]
    rows = problem_rows(db["games"], inputs["excluded"], inputs["sources"], inputs["texts"])
    names_of = seat_names(inputs, srv) if names else None
    records, missing = problem_records(rows, inputs["sources"], inputs["texts"], inputs["snapshot"], names_of)
    in_sync = db_in_sync(db, inputs["rebuilt"])
    out.mkdir(parents=True, exist_ok=True)
    dump(out / "problem_games.json", {
        "format": "console-problem-games", "version": 1, "dbVersion": sha, "withNames": names,
        "groups": {g: GROUP_LABELS[g] for g in GROUPS}, "games": rows, "records": records,
        **({"missingRecords": missing} if missing else {}),
    })
    counts = game_counts(db, rows, sha, now, in_sync)
    dump(out / "game_counts.json", counts)
    collisions = {**NC.detect(inputs["games_doc"], db, inputs["records_doc"]), "dbVersion": sha}
    dump(out / "name_collisions.json", collisions)
    summary = {"problem_games.json": {"games": len(rows), "records": len(records), **counts["problems"]},
               "game_counts.json": {"games": counts["games"], "gameDbInSync": in_sync},
               "name_collisions.json": {"candidates": len(collisions["candidates"]),
                                        **{f"rule_{k}": v["names"] for k, v in collisions["counts"].items()}}}
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--srv", default=str(HERE))
    ap.add_argument("--sha", default="")
    ap.add_argument("--now", default="")
    ap.add_argument("--names", action="store_true", help="add seat nicknames to records (private console only)")
    ap.add_argument("--with-proavalon", dest="with_proavalon", action="store_true", default=None,
                    help="same as game_db.py --with-proavalon (use it when game_db.json was built with it)")
    args = ap.parse_args(argv)
    now = args.now or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    summary = export(Path(args.srv), Path(args.out), args.sha, now, args.names, args.with_proavalon)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
