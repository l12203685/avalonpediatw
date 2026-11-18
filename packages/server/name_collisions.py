"""
同名不同人（名字碰撞）偵測。站長 2026-11-18：「有路人取同id 的話怎麼分辨?」

戰績裡的「玩家」是牌譜上的名字字串：路人取了跟老玩家一樣的暱稱，他的局就算進老玩家的戰績。這支程式從每晚寫好的
games_cache.json（統計用的那一批局，名字已套用 player_aliases.json 的別名與拆分）找出可能是兩個人的名字，給站長在
私人主控台確認；確認後寫進 player_aliases.json 的 "splits"（generate_cache.py 套用，見 docs/stats/two_stage_outcome.md
〈玩家別名〉）。

規則（候選，不自動拆）：
  a1  同一局的兩個座位是同一個名字。一個人不能同時坐兩個位置：一定是兩個人（或座位打錯）。確定。
  a2  同一天、同分類（線瓦／面瓦）、同場次的兩局（不是同一局記兩次：兩局共同的名字少於 SAME_TABLE_SHARED 個），
      這個名字兩局都有。一個人不能同時在兩桌。資料只有日期與場次、沒有時刻（Discord 發文時間是上傳時間，常常
      一次補貼好幾局，不能當開局時間），而場次是各紀錄者自己數的，所以這條是「很可能」，不是證明。
  b   這個名字的局分成幾群，群與群之間沒有任何共同的牌友（每局至少 MIN_COPLAYERS 個其他名字才算，殘缺的名單
      不算）；附每群的分類、Discord 標籤與日期範圍。最常見的就是一群老玩家、另一群完全不認識的人。
  （c 風格／PR 斷層：沒有做。PR 本身就是從合併後的局算出來的，碰撞會把它攪在一起；先看 a、b。）

輸出：
  - name_collisions.json（--out 的資料夾，要在 repo 外面）：候選清單，含名字、局號（S<流水號>／D<hash>，跟
    player_aliases.json "splits" 和 game_db.py 用的一樣）、網站牌譜紀錄的編號、日期、分類、標籤、理由，以及
    主控台 `nameSplits/<id>` 的建議文件（{name, games, as, status: 'pending'}，docs/CONSOLE.md）。只給私人主控台。
  - 公開的地方（docs/data/game_db_report.md、workflow 紀錄）只寫數量：counts()。

Usage:  python name_collisions.py --out <repo 外面的資料夾> [--games games_cache.json] [--db game_db.json]
                                  [--records records_cache.json]
        python name_collisions.py --counts            # 只印數量（可以進公開紀錄）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
FORMAT = "console-name-collisions"
VERSION = 1

BOT_CATEGORY = "百科AI"
MIN_COPLAYERS = 5  # rule b: a game links only when it lists the name and at least this many others
SAME_TABLE_SHARED = 6  # rule a2: two games sharing this many names are one table (or one game entered twice)
# Discord forum tags that say how a game ended or how the post was handled, not where / with whom it was played
OUTCOME_TAGS = frozenset({"三紅", "三藍躲刺", "三藍被刀", "已收錄", "待修正"})
RULES = {
    "a1": ("definitive", "同一局的兩個座位是同一個名字"),
    "a2": ("strong", "同一天、同分類、同場次的兩桌都有這個名字"),
    "b": ("review", "兩群局之間沒有任何共同的牌友"),
}


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def load_json(path: Path) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def is_bot_name(name: str) -> bool:
    return name.startswith(BOT_CATEGORY) or name.startswith("百科機器人")


def stats_games(games_doc: Mapping[str, Any], db: Mapping[str, Any] | None = None,
                records_doc: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """games_cache.json rows -> [{id, site, date, venue, slot, tags, seats: {seat: name}}], 百科AI games left out
    (the stats leave them out too). id = game_db.py's public id (S<流水號> / D<hash>); site = the id of the
    website's 牌譜紀錄 page (the Discord post when the game has one, from game_db.json); tags = that post's forum
    tags other than the outcome ones."""
    idx = {name: i for i, name in enumerate(games_doc.get("fields") or [])}
    if not {"id", "src", "seats"} <= idx.keys():
        return []  # no seat names in this dataset (an old or stripped file): nothing to compare
    players = games_doc.get("players") or []
    cats = (games_doc.get("vocab") or {}).get("category") or []
    get = lambda r, k, default: r[idx[k]] if k in idx and idx[k] < len(r) else default  # noqa: E731
    site_of: dict[str, str] = {}
    for row in (db or {}).get("games", []) if isinstance(db, Mapping) else []:
        for s in row.get("sources", []):
            if s.get("src") in ("sheet", "dc_import"):
                site_of[str(s.get("id"))] = str(row.get("id"))
    tags_of: dict[str, list[str]] = {}
    for post in (records_doc or {}).get("posts", []) if isinstance(records_doc, Mapping) else []:
        tags = [t for t in post.get("tags", []) if isinstance(t, str) and t not in OUTCOME_TAGS]
        if tags:
            tags_of[str(post.get("id"))] = tags
    out: list[dict[str, Any]] = []
    for r in games_doc.get("games") or []:
        ci = get(r, "cat", -1)
        cat = cats[ci] if isinstance(ci, int) and 0 <= ci < len(cats) else ""
        if cat == BOT_CATEGORY:
            continue
        seats: dict[str, str] = {}
        for k, p in zip("1234567890", r[idx["seats"]]):
            if isinstance(p, int) and 0 <= p < len(players) and players[p]:
                seats[k] = players[p]
        if any(is_bot_name(n) for n in seats.values()):
            continue
        raw_id = str(r[idx["id"]])
        gid = "S" + raw_id if r[idx["src"]] == 0 and raw_id.isdigit() else raw_id
        site = site_of.get(gid, gid)
        out.append({
            "id": gid, "site": site, "date": get(r, "date", "") or "", "venue": cat, "slot": get(r, "slot", 0) or 0,
            "tags": [t for t in tags_of.get(site, []) if t != cat], "seats": seats,
        })
    return out


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def _names(g: Mapping[str, Any]) -> set[str]:
    return set(g["seats"].values())


def doubled_seats(games: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Rule a1: {name, game, seats} for every game listing one name on two or more seats."""
    out = []
    for g in games:
        by_name: dict[str, list[str]] = defaultdict(list)
        for seat, name in g["seats"].items():
            by_name[name].append(seat)
        for name, seats in by_name.items():
            if len(seats) > 1:
                out.append({"name": name, "game": g, "seats": seats})
    return out


def same_slot_pairs(games: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Rule a2: {name, games: (g1, g2)} for two different tables of one day, one 分類 and one 場次 that both list
    the name (two games sharing SAME_TABLE_SHARED names or more are one table / one game entered twice)."""
    slots: dict[tuple[str, str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for g in games:
        if g["date"] and g["slot"]:
            slots[(g["date"], g["venue"], g["slot"])].append(g)
    out = []
    for members in slots.values():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                shared = _names(a) & _names(b)
                if len(shared) >= SAME_TABLE_SHARED:
                    continue
                for name in sorted(shared):
                    out.append({"name": name, "games": (a, b)})
    return out


def disjoint_clusters(games: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Rule b: {name, clusters} for every name whose games (those listing it with MIN_COPLAYERS others or more)
    fall into two or more groups that share no co-player at all. Clusters biggest first."""
    by_name: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for g in games:
        names = _names(g)
        if len(names) <= MIN_COPLAYERS:
            continue
        for n in names:
            by_name[n].append(g)
    out = []
    for name, gs in by_name.items():
        if len(gs) < 2:
            continue
        parent = list(range(len(gs)))

        def root(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        first: dict[str, int] = {}
        for i, g in enumerate(gs):
            for co in _names(g) - {name}:
                if co in first:
                    a, b = root(i), root(first[co])
                    if a != b:
                        parent[a] = b
                else:
                    first[co] = i
        groups: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
        for i, g in enumerate(gs):
            groups[root(i)].append(g)
        if len(groups) > 1:
            clusters = sorted(groups.values(), key=lambda c: (-len(c), min(x["date"] or "9999" for x in c), c[0]["id"]))
            out.append({"name": name, "clusters": clusters})
    return out


# ---------------------------------------------------------------------------
# Candidates (private console)
# ---------------------------------------------------------------------------

def _gid_sort(gid: str) -> tuple[int, int, str]:
    return (0, int(gid[1:]), "") if gid[:1] == "S" and gid[1:].isdigit() else (1, 0, gid)


def _game_entry(g: Mapping[str, Any], name: str) -> dict[str, Any]:
    e = {"id": g["id"], "date": g["date"], "venue": g["venue"], "slot": g["slot"],
         "seats": sorted(s for s, n in g["seats"].items() if n == name)}
    if g["site"] != g["id"]:
        e["site"] = g["site"]
    if g["tags"]:
        e["tags"] = g["tags"]
    return e


def _group(games: Sequence[Mapping[str, Any]], name: str) -> dict[str, Any]:
    dates = sorted(g["date"] for g in games if g["date"])
    co = set().union(*(_names(g) for g in games)) - {name}
    return {
        "games": [_game_entry(g, name) for g in sorted(games, key=lambda g: (g["date"] or "9999", _gid_sort(g["id"])))],
        "from": dates[0] if dates else "", "to": dates[-1] if dates else "",
        "venues": dict(Counter(g["venue"] or "（沒記）" for g in games).most_common()),
        "tags": dict(Counter(t for g in games for t in g["tags"]).most_common()),
        "coPlayers": len(co),
    }


def split_doc_id(name: str, games: Iterable[str], seat: str = "") -> str:
    """Stable id of a console nameSplits/<id> doc (same name, games and seat -> same id on every export)."""
    text = name + "|" + ",".join(sorted(games, key=_gid_sort)) + (f"|{seat}" if seat else "")
    return "ns_" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def split_doc(name: str, games: Sequence[str], as_name: str, rule: str, reason: str, seat: str = "") -> dict[str, Any]:
    """The console doc the owner confirms (docs/CONSOLE.md nameSplits/<id>); console:apply writes a confirmed one into
    player_aliases.json "splits" as {"as": as, "games": games[, "seat": seat]} under "name"."""
    ids = sorted(set(games), key=_gid_sort)
    doc = {"id": split_doc_id(name, ids, seat), "name": name, "games": ids, "as": as_name, "status": "pending",
           "rule": rule, "reason": reason}
    if seat:
        doc["seat"] = seat
    return doc


def other_name(name: str, taken: set[str], n: int = 2) -> str:
    """A suggested display name for the other person: name（2）, name（3）... not already a player."""
    while f"{name}（{n}）" in taken:
        n += 1
    return f"{name}（{n}）"


def _ties(g: Mapping[str, Any], name: str, others: Sequence[Mapping[str, Any]]) -> int:
    """How many co-players of `g` also play with `name` in `others` (how well g fits the name's usual crowd)."""
    usual = set().union(*(_names(o) for o in others)) if others else set()
    return len((_names(g) - {name}) & usual)


def candidates(games: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every candidate of rules a1, a2, b, ordered by rule, name and first game."""
    taken = {n for g in games for n in g["seats"].values()}
    by_name: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for g in games:
        for n in _names(g):
            by_name[n].append(g)
    out: list[dict[str, Any]] = []
    for hit in doubled_seats(games):
        name, g, seats = hit["name"], hit["game"], hit["seats"]
        reason = f"{g['id']}（{g['date'] or '沒有日期'}）的 {'、'.join(seats)} 號座位都寫「{name}」：同一個人不能坐兩個位置" \
                 "（多半是座位打錯，那就在來源改；真的有兩個人同名才拆）"
        as_name = other_name(name, taken)
        out.append({
            "rule": "a1", "level": RULES["a1"][0], "name": name, "reason": reason, "games": [g["id"]],
            "groups": [_group([g], name)],
            "suggested": [split_doc(name, [g["id"]], as_name, "a1", reason, seat=seats[-1])],
        })
    pairs: dict[str, list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = defaultdict(list)
    for hit in same_slot_pairs(games):
        pairs[hit["name"]].append(hit["games"])
    for name, items in pairs.items():
        ids = sorted({g["id"] for pair in items for g in pair}, key=_gid_sort)
        lines = [f"{a['date']} {a['venue'] or '（沒記分類）'} 第 {a['slot']} 場：{a['id']} 跟 {b['id']}" for a, b in items]
        reason = "同一天、同分類、同場次的兩桌都有「" + name + "」（" + "；".join(lines) + "）：同一個人不能同時在兩桌" \
                 "（場次是各紀錄者自己數的，請對照當天的紀錄）"
        # suggest the game of each pair whose table fits the name's usual crowd less
        odd = []
        for a, b in items:
            rest = [g for g in by_name[name] if g is not a and g is not b]
            odd.append(min((a, b), key=lambda g: (_ties(g, name, rest), g["date"], _gid_sort(g["id"])))["id"])
        out.append({
            "rule": "a2", "level": RULES["a2"][0], "name": name, "reason": reason, "games": ids,
            "groups": [_group([a, b], name) for a, b in items],
            "suggested": [split_doc(name, odd, other_name(name, taken), "a2", reason)],
        })
    for hit in disjoint_clusters(games):
        name, clusters = hit["name"], hit["clusters"]
        groups = [_group(c, name) for c in clusters]
        desc = []
        for i, gr in enumerate(groups, 1):
            venues = "／".join(gr["venues"])
            tags = ("，標籤 " + "／".join(gr["tags"])) if gr["tags"] else ""
            span = f"{gr['from']}～{gr['to']}" if gr["from"] else "沒有日期"
            desc.append(f"第 {i} 群 {len(gr['games'])} 局（{span}，{venues}{tags}，牌友 {gr['coPlayers']} 人）")
        reason = f"「{name}」的局分成 {len(groups)} 群，群與群之間沒有任何共同的牌友：" + "；".join(desc)
        suggested = []
        used = set(taken)
        for c in clusters[1:]:
            as_name = other_name(name, used)
            used.add(as_name)
            suggested.append(split_doc(name, [g["id"] for g in c], as_name, "b", reason))
        out.append({
            "rule": "b", "level": RULES["b"][0], "name": name, "reason": reason,
            "games": sorted({g["id"] for c in clusters for g in c}, key=_gid_sort), "groups": groups,
            "suggested": suggested,
        })
    order = {r: i for i, r in enumerate(RULES)}
    out.sort(key=lambda c: (order[c["rule"]], c["name"], _gid_sort(c["games"][0])))
    for c in out:
        c["id"] = "nc_" + hashlib.sha1(f"{c['rule']}|{c['name']}|{','.join(c['games'])}".encode("utf-8")).hexdigest()[:12]
    return out


def counts(cands: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Counts only (public report / logs): per rule, names flagged and games involved."""
    out: dict[str, Any] = {}
    for rule in RULES:
        hits = [c for c in cands if c["rule"] == rule]
        out[rule] = {"names": len({c["name"] for c in hits}), "candidates": len(hits),
                     "games": len({g for c in hits for g in c["games"]})}
    return out


def detect(games_doc: Mapping[str, Any] | None, db: Mapping[str, Any] | None = None,
           records_doc: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The console document: {format, version, rules, counts, candidates}. No games_cache.json -> no candidates."""
    games = stats_games(games_doc, db, records_doc) if games_doc else []
    cands = candidates(games)
    return {
        "format": FORMAT, "version": VERSION,
        "rules": {k: {"level": lvl, "name": name} for k, (lvl, name) in RULES.items()},
        "params": {"minCoPlayers": MIN_COPLAYERS, "sameTableShared": SAME_TABLE_SHARED},
        "games": len(games),
        "counts": counts(cands),
        "candidates": cands,
    }


def report_lines(c: Mapping[str, Any]) -> list[str]:
    """Markdown lines for the public game_db report: counts only, never names or game ids."""
    L = ["## 同名不同人（名字碰撞）候選", "",
         "站長 2026-11-18：「有路人取同id 的話怎麼分辨?」。`packages/server/name_collisions.py` 每晚從統計用的局"
         "（`games_cache.json`，已套用別名與拆分）找可能是兩個人的名字。這裡只寫數量；名字、局號與理由只寫進私人主控台"
         "（`console:export` 的 `name_collisions.json`），站長確認後寫進 `player_aliases.json` 的 `splits`"
         "（docs/CONSOLE.md `nameSplits`、docs/stats/two_stage_outcome.md〈玩家別名〉）。", "",
         "| 規則 | 可信度 | 說明 | 名字 | 局數 |", "|---|---|---|---|---|"]
    level = {"definitive": "確定", "strong": "很可能", "review": "要人看"}
    for rule, (lvl, name) in RULES.items():
        n = c.get(rule, {})
        L.append(f"| `{rule}` | {level[lvl]} | {name} | {n.get('names', 0)} | {n.get('games', 0)} |")
    L.append("")
    return L


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        return False
    return True


def write(doc: Mapping[str, Any], out_dir: Path) -> Path:
    if inside_repo(out_dir):
        raise SystemExit(f"name_collisions: --out 要在 repo 外面（{out_dir}）：候選清單有玩家名字，只給私人主控台")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "name_collisions.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return path


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    ap.add_argument("--games", default=str(HERE / "games_cache.json"))
    ap.add_argument("--db", default=str(HERE / "game_db.json"))
    ap.add_argument("--records", default=str(HERE / "records_cache.json"))
    ap.add_argument("--out", help="folder outside the repo for name_collisions.json (private console)")
    ap.add_argument("--counts", action="store_true", help="print counts only (safe for public logs)")
    args = ap.parse_args(argv)
    games_doc = load_json(Path(args.games))
    if not games_doc:
        print(f"name_collisions: {args.games} missing or empty", file=sys.stderr)
        return 1
    doc = detect(games_doc, load_json(Path(args.db)), load_json(Path(args.records)))
    if args.out:
        write(doc, Path(args.out))
    print(json.dumps({"games": doc["games"], "counts": doc["counts"]}, ensure_ascii=False))
    if not args.out and not args.counts:
        print("（加 --out <repo 外面的資料夾> 才會寫出有名字的候選清單）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
