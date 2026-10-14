"""牌譜投票的純函式；只傳出座位與票數，不保留文字記錄。"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable

MIN_VOTES = 10
SEATS = "1234567890"
RED_ROLES = frozenset(("刺客", "莫甘娜", "莫德雷德", "奧伯倫"))
OUTCOMES = frozenset(("三紅", "三藍死", "三藍活"))
TEAM_SIZES = (3, 4, 4, 5, 5)
# 回合、提議序號、隊伍、贊成座位；第 5 次沒有投票，贊成座位固定為空。
VotingProposal = tuple[int, int, str, str]
_PROPOSAL = re.compile(r"^([0-9]{3,5})((?:[+-][0-9]+)*)((?: [0-9+-]+)*)(?: ?([oxOX]{1,5}))?$")
_SYMBOLS = str.maketrans({"−": "-", "–": "-", "—": "-", "×": "x", "✕": "x", "✗": "x", "✘": "x", "○": "o", "◯": "o"})


def parse_voting_proposals(text: str) -> list[VotingProposal]:
    """只採用完整可解析的回合；錯誤提議不縮短序號，避免把強制派隊當作投票。"""
    result: list[VotingProposal] = []
    pending: list[tuple[str, str]] = []
    round_no = 1
    invalid = False

    def finish(mission: str) -> None:
        nonlocal pending, round_no, invalid
        if round_no > 5:
            return
        size = TEAM_SIZES[round_no - 1]
        if pending and not invalid and 1 <= len(pending) <= 5 and len(mission) == size:
            result.extend((round_no, i, team, approved if i < 5 else "")
                          for i, (team, approved) in enumerate(pending, 1))
        # 空白／損壞回合仍前進，不能將下一局誤標為上一局。
        if pending or invalid:
            round_no += 1
        pending, invalid = [], False

    for raw in (text or "").splitlines():
        line = " ".join(unicodedata.normalize("NFKC", raw).translate(_SYMBOLS).strip().strip("`*_~|").split())
        if not line or round_no > 5:
            continue
        if re.fullmatch(r"[oxOX](?: ?[oxOX]){0,4}", line):
            finish(line.replace(" ", ""))
            continue
        if re.fullmatch(r"[0-9] ?> ?[0-9](?: ?[oxOX?])?|[0-9]{2} ?[oxOX]", line):
            continue
        match = _PROPOSAL.fullmatch(line)
        if not match:
            # 配置、刺殺與名單是收尾資料；其餘無法辨識的文字不猜票。
            if re.fullmatch(r"[0-9]{6}", line) or line.startswith("刺") or re.match(r"[0-9]{1,2}[.、:]", line):
                continue
            invalid = True
            continue
        team, glued, rest, mission = match.groups()
        if len(team) != TEAM_SIZES[round_no - 1] or len(set(team)) != len(team):
            invalid = True
        approved = set(team)
        seen: dict[str, str] = {}
        for token in ([glued] if glued else []) + rest.split():
            if re.fullmatch(r"(?:[0-9]+[+-])+", token):
                groups = re.findall(r"([0-9]+)([+-])", token)
            elif re.fullmatch(r"(?:[+-][0-9]+)+", token):
                groups = [(digits, sign) for sign, digits in re.findall(r"([+-])([0-9]+)", token)]
            else:
                invalid = True
                continue
            for digits, sign in groups:
                for seat in digits:
                    if seat in seen and seen[seat] != sign:
                        invalid = True
                    seen[seat] = sign
                    if sign == "+":
                        approved.add(seat)
                    else:
                        approved.discard(seat)
        pending.append((team, "".join(s for s in SEATS if s in approved)))
        if mission:
            finish(mission)
    return result


def _cell() -> dict[str, Any]:
    return {"hits": 0, "votes": 0, "rate": None, "pr": None, "cohortPlayers": 0}


def _empty() -> dict[str, Any]:
    return {"version": 1, "minVotes": MIN_VOTES,
            "r3Reject": {"loyal": _cell(), "red": _cell()},
            "teamComposition": {window: {"evilTeamReject": _cell(), "goodTeamApprove": _cell()}
                                for window in ("all", "r3Plus")}}


def compute_player_voting(games: Iterable[Any]) -> dict[str, dict[str, Any]]:
    """輸入已合併別名的 GameRow；分母是一位玩家的一張有效票，PR 只比同指標滿 10 票者。"""
    rows: dict[str, dict[str, Any]] = {}
    for game in games:
        if game.outcome not in OUTCOMES:
            continue
        for name in game.seat_players.values():
            rows.setdefault(name, _empty())
        proposals = getattr(game, "voting_proposals", None)
        if proposals is None:
            proposals = parse_voting_proposals(getattr(game, "text_record", ""))
        for round_no, attempt, team, approved in proposals:
            if attempt >= 5:
                continue
            roles = [game.seat_roles.get(seat) for seat in team]
            if any(role not in RED_ROLES | {"梅林", "派西維爾", "忠臣"} for role in roles):
                continue
            evil_team = any(role in RED_ROLES for role in roles)
            for seat, name in game.seat_players.items():
                row = rows[name]
                reject = seat not in approved
                role = game.seat_roles.get(seat)
                perspective = "red" if role in RED_ROLES else "loyal" if role == "忠臣" else None
                cells = []
                if round_no >= 3 and perspective:
                    cells.append((row["r3Reject"][perspective], reject))
                metric = "evilTeamReject" if evil_team else "goodTeamApprove"
                for window in ("all", "r3Plus") if round_no >= 3 else ("all",):
                    cells.append((row["teamComposition"][window][metric], reject if evil_team else not reject))
                for cell, hit in cells:
                    cell["votes"] += 1
                    cell["hits"] += int(hit)
    paths = [("r3Reject", p) for p in ("loyal", "red")] + [
        ("teamComposition", w, m) for w in ("all", "r3Plus") for m in ("evilTeamReject", "goodTeamApprove")]
    for path in paths:
        cells = []
        for row in rows.values():
            cell = row
            for key in path:
                cell = cell[key]
            if cell["votes"] >= MIN_VOTES:
                cell["rate"] = round(cell["hits"] / cell["votes"] * 100 * 10) / 10
            cells.append(cell)
        values = [cell["rate"] for cell in cells if cell["rate"] is not None]
        for cell in cells:
            cell["cohortPlayers"] = len(values)
            if cell["rate"] is not None:
                less = sum(v < cell["rate"] for v in values)
                equal = sum(v == cell["rate"] for v in values)
                cell["pr"] = round((less + equal / 2) / len(values) * 100 * 10) / 10
    return rows
