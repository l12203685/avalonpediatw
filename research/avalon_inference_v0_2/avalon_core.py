"""Independent, dependency-free Avalon exact-enumeration inference baseline (v0.1).

Research prototype only. This is NOT CSP4SDG/GRAIL and does not model strategic
proposal/voting/chat policy. It never reads hidden roles not supplied via the
observer's permitted private information.
"""
from __future__ import annotations
from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import combinations
from functools import cached_property
from math import comb, exp, log, log2
from typing import Iterable

EVIL = frozenset(("Assassin", "Morgana", "Mordred", "Oberon", "Minion"))
MISSIONS = {
    5: (2, 3, 2, 3, 3),
    6: (2, 3, 4, 3, 4),
    7: (2, 3, 3, 4, 4),
    8: (3, 4, 4, 5, 5),
    9: (3, 4, 4, 5, 5),
    10: (3, 4, 4, 5, 5),
}
CONFIGS = {
    5: ("Merlin", "Percival", "Servant", "Assassin", "Morgana"),
    6: ("Merlin", "Percival", "Servant", "Servant", "Assassin", "Morgana"),
    7: ("Merlin", "Percival", "Servant", "Servant", "Assassin", "Morgana", "Mordred"),
    8: ("Merlin", "Percival", "Servant", "Servant", "Servant", "Assassin", "Morgana", "Mordred"),
    9: ("Merlin", "Percival", "Servant", "Servant", "Servant", "Servant", "Assassin", "Morgana", "Mordred"),
    10: ("Merlin", "Percival", "Servant", "Servant", "Servant", "Servant", "Assassin", "Morgana", "Mordred", "Oberon"),
}


@dataclass(frozen=True)
class Rules:
    player_count: int
    roles: tuple[str, ...]

    @classmethod
    def standard(cls, player_count: int) -> "Rules":
        if player_count not in CONFIGS:
            raise ValueError("Supported player_count: 5..10")
        return cls(player_count, CONFIGS[player_count])

    def mission_size(self, round_no: int) -> int:
        if not (1 <= round_no <= 5):
            raise ValueError("round_no must be 1..5")
        return MISSIONS[self.player_count][round_no - 1]

    def required_fails(self, round_no: int) -> int:
        return 2 if self.player_count >= 7 and round_no == 4 else 1


@dataclass(frozen=True)
class PrivateInfo:
    seat: int
    own_role: str
    # Exact known evil seats, visible to Merlin. Mordred does not appear.
    merlin_seen_evil: tuple[int, ...] = ()
    # Unordered pair: Merlin and Morgana, without specifying which.
    percival_candidates: tuple[int, ...] = ()
    # For normal evil players, other evil players except Oberon.
    evil_known_allies: tuple[int, ...] = ()


@dataclass(frozen=True)
class MissionObservation:
    round_no: int
    team: tuple[int, ...]
    fail_cards: int


@dataclass(frozen=True)
class SoftSignal:
    target: int
    says_evil: bool
    sensitivity: float = 0.75  # P(signal says evil | target evil)
    specificity: float = 0.75  # P(signal says good | target good)


def unique_worlds(roles: tuple[str, ...]) -> Iterable[tuple[str, ...]]:
    """Yield unique role assignments; handles identical Servants without permutations blowup."""
    counts = Counter(roles)
    chosen: list[str] = []
    ordered = tuple(sorted(counts))

    def rec():
        if len(chosen) == len(roles):
            yield tuple(chosen)
            return
        for role in ordered:
            if counts[role] > 0:
                counts[role] -= 1
                chosen.append(role)
                yield from rec()
                chosen.pop()
                counts[role] += 1
    yield from rec()


def private_view(world: tuple[str, ...], seat: int) -> PrivateInfo:
    """Test-fixture helper. In production this must be called by the game server only."""
    role = world[seat]
    if role == "Merlin":
        return PrivateInfo(seat, role, merlin_seen_evil=tuple(i for i, r in enumerate(world) if r in EVIL and r != "Mordred"))
    if role == "Percival":
        return PrivateInfo(seat, role, percival_candidates=tuple(i for i, r in enumerate(world) if r in ("Merlin", "Morgana")))
    if role in EVIL and role != "Oberon":
        return PrivateInfo(seat, role, evil_known_allies=tuple(i for i, r in enumerate(world) if i != seat and r in EVIL and r != "Oberon"))
    return PrivateInfo(seat, role)


def matches_private(world: tuple[str, ...], info: PrivateInfo | None) -> bool:
    if info is None:
        return True
    if world[info.seat] != info.own_role:
        return False
    # exact visibility sets (not just positive membership)
    if info.own_role == "Merlin":
        return set(info.merlin_seen_evil) == {i for i, r in enumerate(world) if r in EVIL and r != "Mordred"}
    if info.own_role == "Percival":
        return set(info.percival_candidates) == {i for i, r in enumerate(world) if r in ("Merlin", "Morgana")}
    if info.own_role in EVIL and info.own_role != "Oberon":
        return set(info.evil_known_allies) == {i for i, r in enumerate(world) if i != info.seat and r in EVIL and r != "Oberon"}
    return not (info.merlin_seen_evil or info.percival_candidates or info.evil_known_allies)


def validate_private(rules: Rules, info: PrivateInfo | None):
    if info is None:
        return
    if not 0 <= info.seat < rules.player_count or info.own_role not in rules.roles:
        raise ValueError("Invalid private observer info")
    for fields in (info.merlin_seen_evil, info.percival_candidates, info.evil_known_allies):
        if len(fields) != len(set(fields)) or any(s < 0 or s >= rules.player_count for s in fields):
            raise ValueError("Invalid private observer info seats")
    if info.own_role != "Merlin" and info.merlin_seen_evil:
        raise ValueError("Forbidden Merlin visibility")
    if info.own_role != "Percival" and info.percival_candidates:
        raise ValueError("Forbidden Percival visibility")
    if info.own_role not in EVIL - {"Oberon"} and info.evil_known_allies:
        raise ValueError("Forbidden evil visibility")


def validate_observation(rules: Rules, observation: MissionObservation):
    if len(observation.team) != rules.mission_size(observation.round_no):
        raise ValueError("Team size does not match round/rules")
    if len(set(observation.team)) != len(observation.team) or any(not 0 <= i < rules.player_count for i in observation.team):
        raise ValueError("Invalid or duplicated seats on team")
    if not 0 <= observation.fail_cards <= len(observation.team):
        raise ValueError("Invalid fail_cards")


def sabotage_distribution(evil_on_team: int, sabotage_probability: float) -> tuple[float, ...]:
    q = sabotage_probability
    if not 0 <= q <= 1:
        raise ValueError("sabotage_probability must be in [0,1]")
    return tuple(comb(evil_on_team, k) * q**k * (1-q)**(evil_on_team-k) for k in range(evil_on_team + 1))


def entropy_bits(probabilities: Iterable[float]) -> float:
    return -sum(p * log2(p) for p in probabilities if p > 0)


def _log_likelihood(world, observations, signals, q):
    total = 0.0
    for obs in observations:
        k = sum(world[seat] in EVIL for seat in obs.team)
        likelihood = sabotage_distribution(k, q)[obs.fail_cards] if obs.fail_cards <= k else 0.0
        if likelihood == 0:
            return float("-inf")
        total += log(likelihood)
    for s in signals:
        evil = world[s.target] in EVIL
        pr = (s.sensitivity if evil else 1-s.specificity) if s.says_evil else (1-s.sensitivity if evil else s.specificity)
        if pr == 0:
            return float("-inf")
        total += log(pr)
    return total


@dataclass
class Posterior:
    rules: Rules
    worlds: list[tuple[str, ...]]
    weights: list[float]
    q: float

    @property
    def entropy(self) -> float:
        return entropy_bits(self.weights)

    def role_marginals(self) -> dict[int, dict[str, float]]:
        result = {seat: defaultdict(float) for seat in range(self.rules.player_count)}
        for world, w in zip(self.worlds, self.weights):
            for seat, role in enumerate(world):
                result[seat][role] += w
        return {seat: dict(sorted(mapping.items())) for seat, mapping in result.items()}

    def evil_marginals(self) -> dict[int, float]:
        role_probs = self.role_marginals()
        return {s: sum(p for r, p in rp.items() if r in EVIL) for s, rp in role_probs.items()}

    @cached_property
    def evil_mask_weights(self) -> dict[int, float]:
        """Compress exact-role assignments by faction mask for fast mission evaluation."""
        mass: dict[int, float] = defaultdict(float)
        for world, weight in zip(self.worlds, self.weights):
            mask = sum((1 << seat) for seat, role in enumerate(world) if role in EVIL)
            mass[mask] += weight
        return dict(mass)

    def mission_value(self, team: tuple[int, ...], round_no: int) -> dict:
        team = tuple(team)
        if len(team) != self.rules.mission_size(round_no) or len(set(team)) != len(team) or any(not 0 <= s < self.rules.player_count for s in team):
            raise ValueError("Invalid mission team")
        pk = [0.] * (len(team) + 1)
        team_mask = sum(1 << s for s in team)
        for evil_mask, mass in self.evil_mask_weights.items():
            k = (team_mask & evil_mask).bit_count()
            pk[k] += mass
        y = [0.] * (len(team) + 1)
        noise_entropy = 0.
        for k, mass in enumerate(pk):
            if mass == 0:
                continue
            obs = sabotage_distribution(k, self.q)
            noise_entropy += mass * entropy_bits(obs)
            for f, prob in enumerate(obs):
                y[f] += mass * prob
        ig = max(0., entropy_bits(y) - noise_entropy)
        required = self.rules.required_fails(round_no)
        return {
            "team": list(team), "round_no": round_no,
            "fail_threshold": required,
            "p_mission_success": sum(y[:required]),
            "p_mission_failure": sum(y[required:]),
            "expected_information_gain_bits": ig,
            "expected_posterior_entropy_bits": self.entropy - ig,
            "p_fail_cards": y,
            "p_evil_count_on_team": pk,
        }


def infer(rules: Rules, observer: PrivateInfo | None = None,
          observations: Iterable[MissionObservation] = (),
          signals: Iterable[SoftSignal] = (),
          sabotage_probability: float = .8) -> Posterior:
    q = sabotage_probability
    if not 0 <= q <= 1:
        raise ValueError("Invalid sabotage probability")
    validate_private(rules, observer)
    observations = tuple(observations)
    signals = tuple(signals)
    for obs in observations:
        validate_observation(rules, obs)
    for s in signals:
        if not 0 <= s.target < rules.player_count or not 0 <= s.sensitivity <= 1 or not 0 <= s.specificity <= 1:
            raise ValueError("Invalid soft signal")
    worlds: list[tuple[str, ...]] = []
    logs: list[float] = []
    for world in unique_worlds(rules.roles):
        if not matches_private(world, observer):
            continue
        ll = _log_likelihood(world, observations, signals, q)
        if ll != float("-inf"):
            worlds.append(world)
            logs.append(ll)
    if not logs:
        raise ValueError("Observations/private view are inconsistent or have zero likelihood")
    largest = max(logs)
    raw = [exp(logw - largest) for logw in logs]
    z = sum(raw)
    return Posterior(rules, worlds, [r/z for r in raw], q)


def rank_teams(posterior: Posterior, round_no: int, top_n=5) -> dict:
    candidates = (posterior.mission_value(team, round_no) for team in combinations(range(posterior.rules.player_count), posterior.rules.mission_size(round_no)))
    scored = list(candidates)
    by_success = sorted(scored, key=lambda r:(-r["p_mission_success"], -r["expected_information_gain_bits"], r["team"]))[:top_n]
    by_ig = sorted(scored, key=lambda r:(-r["expected_information_gain_bits"], -r["p_mission_success"], r["team"]))[:top_n]
    return {"top_success": by_success, "top_information_gain": by_ig, "candidate_count": len(scored)}