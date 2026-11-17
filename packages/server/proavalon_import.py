"""
ProAvalon（外部、匿名）→ 牌譜總庫的分析局（Edward 2026-11-17：「10人局配置一模一樣 有湖中的才需要納入分析
其他就不用分析了 先存著牌譜就好」）.

Input: the anonymized ProAvalon export (2018–2022; players already renamed a, b, c … per game), split by
player count × role configuration × lake in the owner's PRIVATE repo
(digital-immortal-tree-lyh: data/external/proavalon/10p/梅派刺娜德奧/lake.jsonl.gz -- strict JSON, one game per
line). Only that bucket is converted: 10 players, roles exactly 梅林 派西維爾 刺客 莫甘娜 莫德雷德 奧伯倫 (four
reds, like our games), with a Lady of the Lake. Games lost on a rejected 5th proposal ("Hammer rejected.") are
left out: our games never vote on the 5th proposal (it always goes), so they have no comparable ending.

Output: packages/server/proavalon_games.json -- the site's game object per game (no names), read by
game_db.py as the source ``proavalon``. Those rows carry ``external: true`` so the stats layer can leave
them out by default (nothing reads them yet besides the game database).

Mapping:
  seats      ProAvalon lists the players in seat order a, b, c … (playerUsernamesOrdered; empty or with a
             None in older records, then the letters are the seat order -- checked against the leader
             rotation) and passes the leader to the PREVIOUS player. Our notation passes it to the next
             seat number, so seat 1 = the first player, seat 2 = the last, seat 3 = the one before … .
  roles      playerRoles → 配置 (刺 娜 德 奧 派 梅 seats).
  proposals  voteHistory[player][round][proposal] tags: VHleader, VHpicked (on the team), VHapprove.
             The 5th proposal's votes are kept (ProAvalon votes on it; our validation skips attempt 5).
  missions   numFailsHistory → 'o' × (size − fails) + 'x' × fails. Old records have only missionHistory
             (succeeded / failed): a failed mission gets the fewest fails that fail it (1, or 2 in round 4)
             and the game is flagged.
  lake       ladyHistoryUsernames = holder, then each target (who holds next): lake k = seq[k] → seq[k+1].
             ProAvalon does not record what the holder said, so ``claim`` is empty. When the usernames are
             missing (some old records) the lakes are left out and the game is flagged.
  刺殺       whoAssassinShot is the shot player's ROLE: a unique role (梅林、派西、奧伯倫 …) gives the seat;
             a loyal servant ('Resistance') does not -- the target stays empty and the game is flagged.
  result     Mission fails → 三紅; Assassinated Merlin correctly → 三藍死; Resistance wins → 三藍活.

Usage:  python proavalon_import.py <lake.jsonl.gz> [--output proavalon_games.json]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping

import discord_records_import as dri
import generate_cache as gc
import records_merge as rm

HERE = Path(__file__).resolve().parent
FORMAT = "proavalon-games"
SOURCE = "ProAvalon anonymized export gameRecordsDataAnon_20220606 (2018-2022)"
ROLE_SLOT = {"Assassin": 0, "Morgana": 1, "Mordred": 2, "Oberon": 3, "Percival": 4, "Merlin": 5}  # 配置 order
ANALYSIS_ROLES = set(ROLE_SLOT)
HAMMER = "Hammer rejected."
FLAG_LAKE_SEATS = "proavalon:lakeSeatsUnknown"
FLAG_SHOT_LOYAL = "proavalon:shotLoyalSeatUnknown"
FLAG_NO_CLAIMS = "proavalon:noLakeClaims"
FLAG_FAILS_UNKNOWN = "proavalon:failCountUnknown"


def seat_order(rec: Mapping[str, Any]) -> list[str] | None:
    """Usernames in seat order 1, 2, … 9, 0 (our leader rotation), or None when it cannot be told."""
    keys = sorted(rec.get("voteHistory", {}))
    order = list(rec.get("playerUsernamesOrdered") or [])
    if order:
        for i, p in enumerate(order):  # an anonymized username that came out as None: the letter of its slot
            if p is None and chr(97 + i) in keys and chr(97 + i) not in order:
                order[i] = chr(97 + i)
    else:
        order = keys
    if len(order) != 10 or set(order) != set(keys) or set(order) != set(rec.get("playerRoles", {})):
        return None
    return [order[0], *reversed(order[1:])]


def convert(rec: Mapping[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """(entry, '') or (None, reason)."""
    if rec.get("numberOfPlayers") != 10 or rec.get("gameMode") != "avalon" or set(rec.get("roles") or []) != ANALYSIS_ROLES:
        return None, "not 10 players with 梅派刺娜德奧"
    if not rec.get("ladyChain"):
        return None, "no lake"
    if rec.get("howTheGameWasWon") == HAMMER:
        return None, "lost on a rejected 5th proposal (not in our rules)"
    order = seat_order(rec)
    if order is None:
        return None, "seat order unknown"
    seat_of = {p: gc.SEATS[i] for i, p in enumerate(order)}
    roles = {p: r["role"] for p, r in rec["playerRoles"].items()}
    config = [""] * 6
    for p, role in roles.items():
        if role in ROLE_SLOT:
            config[ROLE_SLOT[role]] = seat_of[p]
    if "" in config:
        return None, "roles incomplete"
    config_s = "".join(config)
    vh = rec["voteHistory"]
    fails = list(rec.get("numFailsHistory") or [])
    results = list(rec.get("missionHistory") or [])
    n_rounds = len(vh[order[0]])
    fails_unknown = False
    rounds = []
    leaders: list[str] = []
    for r in range(n_rounds):
        proposals = []
        for k in range(len(vh[order[0]][r])):
            tags = {p: str(vh[p][r][k]) if r < len(vh[p]) and k < len(vh[p][r]) else "" for p in order}
            team = "".join(seat_of[p] for p in order if "VHpicked" in tags[p])
            team = "".join(sorted(team, key=gc.SEATS.index))
            approvers = "".join(seat_of[p] for p in order if "VHapprove" in tags[p])
            leader = [seat_of[p] for p in order if "VHleader" in tags[p]]
            leaders.append(leader[0] if len(leader) == 1 else "")
            proposals.append({"team": team, "votes": rm.vote_tokens(team, approvers)})
        mission = ""
        if r < len(results) and proposals:
            size = len(proposals[-1]["team"])
            if r < len(fails) and len(fails) == len(results):
                x = int(fails[r])
            else:  # old records: only succeeded / failed -- the fewest fails that make it fail
                x = 0 if results[r] == "succeeded" else (2 if r == 3 else 1)
                fails_unknown = fails_unknown or results[r] != "succeeded"
            mission = "o" * (size - x) + "x" * x
        rounds.append({"proposals": proposals, "mission": mission})
    steps = [(gc.SEATS.index(b) - gc.SEATS.index(a)) % 10 for a, b in zip(leaders, leaders[1:]) if a and b]
    if any(s != 1 for s in steps):
        return None, "leader rotation does not follow the seat order"
    flags = [FLAG_NO_CLAIMS] + ([FLAG_FAILS_UNKNOWN] if fails_unknown else [])
    lakes = []
    seq = [seat_of.get(p) for p in rec.get("ladyHistoryUsernames") or []]
    if not seq or None in seq:
        flags.append(FLAG_LAKE_SEATS)
    else:
        for k in range(len(seq) - 1):
            after = 2 + k
            if after >= len(rounds):
                break
            lakes.append({"after": after, "holder": seq[k], "target": seq[k + 1], "claim": ""})
    shot = rec.get("whoAssassinShot")
    kill = ""
    if shot:
        holders = [seat_of[p] for p, role in roles.items() if role == shot]
        if len(holders) == 1:
            kill = holders[0]
        else:
            flags.append(FLAG_SHOT_LOYAL)
    if rec.get("winningTeam") == "Resistance":
        outcome = gc.OUTCOME_BLUE_ALIVE
    elif shot == "Merlin" or rec.get("howTheGameWasWon") == "Assassinated Merlin correctly.":
        outcome = gc.OUTCOME_BLUE_DEAD
    else:
        outcome = gc.OUTCOME_THREE_RED
    return {
        "id": str(rec["_id"]),
        "date": str(rec.get("timeGameStarted", ""))[:10],
        "venue": "線瓦",
        "flags": sorted(flags),
        "game": {"config": config_s, "rounds": rounds, "lakes": lakes, "assassination": kill, "outcome": outcome},
    }, ""


def read_jsonl_gz(path: Path) -> Iterable[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bucket", help="data/external/proavalon/10p/梅派刺娜德奧/lake.jsonl.gz from the private repo")
    ap.add_argument("--output", default=str(HERE / "proavalon_games.json"))
    args = ap.parse_args(argv)
    games: list[dict[str, Any]] = []
    skipped: dict[str, int] = {}
    total = 0
    for rec in read_jsonl_gz(Path(args.bucket)):
        total += 1
        entry, reason = convert(rec)
        if entry is None:
            skipped[reason] = skipped.get(reason, 0) + 1
        else:
            games.append(entry)
    games.sort(key=lambda g: (g["date"], g["id"]))
    head = {"format": FORMAT, "source": SOURCE, "external": True, "read": total, "imported": len(games), "skipped": skipped}
    text = json.dumps(head, ensure_ascii=False, sort_keys=True)[:-1] + ',"games":[\n'
    text += ",\n".join(json.dumps(g, ensure_ascii=False, separators=(",", ":")) for g in games) + "\n]}\n"
    Path(args.output).write_text(text, encoding="utf-8")
    print(f"proavalon: read {total}, imported {len(games)}, skipped {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
