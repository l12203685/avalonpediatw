"""Offline tests for proavalon_import.py (synthetic ProAvalon-shaped records, no real data).

    python packages/server/test_proavalon_import.py
"""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_db as gd  # noqa: E402
import proavalon_import as pa  # noqa: E402

LETTERS = list("abcdefghij")
# seat order in our notation: a=1, j=2, i=3, h=4, g=5, f=6, e=7, d=8, c=9, b=0 (ProAvalon passes the lead backwards)
ROLES = {"a": "Merlin", "b": "Resistance", "c": "Resistance", "d": "Assassin", "e": "Resistance",
         "f": "Morgana", "g": "Mordred", "h": "Percival", "i": "Oberon", "j": "Resistance"}


def tags(leader, team, approve):
    def one(p):
        t = []
        if p in team:
            t.append("VHpicked")
        if p == leader:
            t.append("VHleader")
        t.append("VHapprove" if p in approve else "VHreject")
        return " ".join(t)
    return {p: one(p) for p in LETTERS}


def record(**over):
    # leaders go a, j, i (backwards in ProAvalon order = seats 1, 2, 3)
    props = [
        [tags("a", "ajb", set("ajbcdef"))],                       # R1: team seats 1,2,0
        [tags("j", "ajib", set("ajibcde"))],                      # R2: 1,2,3,0
        [tags("i", "aihb", set("abchi")), tags("h", "ajhb", set("ajhbcdeg"))],  # R3: first rejected
    ]
    vh = {p: [[r[k][p] for k in range(len(r))] for r in props] for p in LETTERS}
    rec = {
        "_id": "abc123", "timeGameStarted": "2021-03-04T05:06:07.000Z", "gameMode": "avalon",
        "numberOfPlayers": 10, "roles": ["Merlin", "Percival", "Assassin", "Morgana", "Mordred", "Oberon"],
        "playerUsernamesOrdered": LETTERS, "playerRoles": {p: {"role": r} for p, r in ROLES.items()},
        "voteHistory": vh, "missionHistory": ["succeeded", "succeeded", "succeeded"], "numFailsHistory": [0, 0, 0],
        "ladyChain": ["Resistance", "Percival"], "ladyHistoryUsernames": ["b", "h"],
        "winningTeam": "Resistance", "whoAssassinShot": "Percival",
        "howTheGameWasWon": "Mission successes and assassin shot wrong.",
    }
    rec.update(over)
    return rec


class ConvertTest(unittest.TestCase):
    def test_seats_roles_votes_lake_and_result(self):
        entry, reason = pa.convert(record())
        self.assertEqual(reason, "")
        g = entry["game"]
        self.assertEqual(g["config"], "865341")  # 刺 d=8 娜 f=6 德 g=5 奧 i=3 派 h=4 梅 a=1
        self.assertEqual([r["proposals"][0]["team"] for r in g["rounds"]], ["120", "1230", "1340"])
        self.assertEqual(g["rounds"][0]["mission"], "ooo")
        self.assertEqual(g["lakes"], [{"after": 2, "holder": "0", "target": "4", "claim": ""}])
        self.assertEqual((g["assassination"], g["outcome"]), ("4", "三藍活"))
        self.assertIn(pa.FLAG_NO_CLAIMS, entry["flags"])
        rows = gd.build(gd.proavalon_sources({"games": [entry]}))
        self.assertTrue(rows[0]["external"])
        self.assertEqual(rows[0]["id"], "Pabc123")
        self.assertNotIn(gd.ERROR, [c["level"] for c in rows[0]["checks"]])

    def test_filters(self):
        self.assertIsNone(pa.convert(record(numberOfPlayers=8))[0])
        self.assertIsNone(pa.convert(record(ladyChain=[]))[0])
        self.assertIsNone(pa.convert(record(howTheGameWasWon=pa.HAMMER))[0])

    def test_old_records_without_order_or_fail_counts(self):
        entry, _ = pa.convert(record(playerUsernamesOrdered=[], numFailsHistory=[],
                                     missionHistory=["succeeded", "failed", "succeeded"]))
        self.assertEqual(entry["game"]["rounds"][1]["mission"], "ooox")
        self.assertIn(pa.FLAG_FAILS_UNKNOWN, entry["flags"])

    def test_shot_loyal_seat_unknown(self):
        entry, _ = pa.convert(record(whoAssassinShot="Resistance"))
        self.assertEqual(entry["game"]["assassination"], "")
        self.assertIn(pa.FLAG_SHOT_LOYAL, entry["flags"])
        row = gd.build(gd.proavalon_sources({"games": [entry]}))[0]
        self.assertNotIn("ASSASSIN_MISSING", [c["rule"] for c in row["checks"]])


if __name__ == "__main__":
    unittest.main()
