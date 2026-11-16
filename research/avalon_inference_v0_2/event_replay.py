"""Deterministic, offline Avalon event replay with per-seat information barriers.

Research-only: deliberately separate from production GameEngine. No dialogue,
behavioral likelihood or strategy estimates. 0-based seats; website seat '0 家'
corresponds to seat index 9, not index 0.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from copy import deepcopy
from typing import Literal, Mapping

from avalon_core import EVIL, PrivateInfo, Rules, MissionObservation, Posterior, infer, private_view

RejectPolicy = Literal['fifth_rejection_evil_win', 'fifth_proposal_forced_approve']


@dataclass(frozen=True)
class ReplayRules:
    """Versioned snapshot, not an assertion that all house rules are official."""
    game: Rules
    ruleset_id: str = 'avalon-replay/v0.2'
    rejection_policy: RejectPolicy = 'fifth_proposal_forced_approve'
    lady_enabled: bool = False
    lady_start_holder: int | None = None
    lady_after_quests: tuple[int, ...] = (2, 3, 4)
    quest_sizes: tuple[int, ...] | None = None
    quest4_fails_required: int | None = None
    nine_player_inverted_protection: bool = False

    def __post_init__(self):
        n = self.game.player_count
        if n != len(self.game.roles) or n < 5 or n > 10:
            raise ValueError('Invalid player count / roles')
        if self.rejection_policy not in ('fifth_rejection_evil_win', 'fifth_proposal_forced_approve'):
            raise ValueError('Unknown rejection policy')
        if not self.ruleset_id.strip():
            raise ValueError('A ruleset id is required')
        if self.quest_sizes is not None and (len(self.quest_sizes) != 5 or any(not 1 <= k <= n for k in self.quest_sizes)):
            raise ValueError('quest_sizes must contain five valid team sizes')
        if self.quest4_fails_required is not None and self.quest4_fails_required not in (1, 2):
            raise ValueError('Fourth quest threshold must be 1 or 2')
        if self.nine_player_inverted_protection and (n != 9 or self.quest_sizes != (4, 3, 4, 5, 5)):
            raise ValueError('Inverted protection is only defined for the 9p Oberon variant')
        if self.lady_enabled:
            if n < 7 or self.lady_start_holder is None or not 0 <= self.lady_start_holder < n:
                raise ValueError('Lady requires >=7 players and valid initial holder')
            if len(set(self.lady_after_quests)) != len(self.lady_after_quests) or any(x not in (2, 3, 4) for x in self.lady_after_quests):
                raise ValueError('Lady timing must use unique quest numbers 2, 3, 4')
        elif self.lady_start_holder is not None:
            raise ValueError('Disabled Lady cannot have a holder')

    def team_size(self, quest: int) -> int:
        if not 1 <= quest <= 5:
            raise ValueError('Quest must be between 1 and 5')
        return (self.quest_sizes or tuple(self.game.mission_size(r) for r in range(1, 6)))[quest-1]

    def fails_required(self, quest: int) -> int:
        if not 1 <= quest <= 5:
            raise ValueError('Quest must be between 1 and 5')
        return self.quest4_fails_required if quest == 4 and self.quest4_fails_required is not None else self.game.required_fails(quest)

    @classmethod
    def platform_10p(cls, lady_start_holder: int = 9) -> 'ReplayRules':
        """Snapshot of current ten-player platform's fifth-proposal & Lady conventions."""
        return cls(Rules.standard(10), lady_enabled=True, lady_start_holder=lady_start_holder)

    @classmethod
    def official_style(cls, count: int, *, lady_start_holder: int | None = None) -> 'ReplayRules':
        """Fifth rejected proposal = evil victory; Lady explicitly opt-in."""
        return cls(Rules.standard(count), rejection_policy='fifth_rejection_evil_win',
                   lady_enabled=lady_start_holder is not None, lady_start_holder=lady_start_holder)


@dataclass
class Replay:
    """Server-side, append-only replay; never serialize __dict__ or _secret_roles.

    `apply` accepts *public* event payloads only. Private Lady results and
    assignments are computed from a trusted secret and never stored as events.
    This API is not a security boundary against code executing in this process:
    a real server must enforce the authenticated observer on the transport layer.
    """
    rules: ReplayRules
    secret_roles: tuple[str, ...] = field(repr=False)
    first_leader: int = 0
    phase: str = field(default='proposal', init=False)
    quest: int = field(default=1, init=False)
    attempts: int = field(default=0, init=False)
    success_count: int = field(default=0, init=False)
    failure_count: int = field(default=0, init=False)
    winner: str | None = field(default=None, init=False)
    events: list[dict] = field(default_factory=list, init=False, repr=False)
    _leader: int = field(default=0, init=False, repr=False)
    _team: tuple[int, ...] = field(default=(), init=False, repr=False)
    _lady_holder: int | None = field(default=None, init=False, repr=False)
    _lady_used: set[int] = field(default_factory=set, init=False, repr=False)

    def __post_init__(self):
        n = self.rules.game.player_count
        if tuple(sorted(self.secret_roles)) != tuple(sorted(self.rules.game.roles)):
            raise ValueError('Secret roles must exactly match ruleset')
        if not 0 <= self.first_leader < n:
            raise ValueError('Invalid first leader')
        self._leader = self.first_leader
        if self.rules.lady_enabled:
            self._lady_holder = self.rules.lady_start_holder
            self._lady_used = {self._lady_holder}

    def apply(self, event: Mapping) -> dict:
        """Atomically validate one event before committing the public record.

        Kinds: proposal {leader,team}, vote {ballots}, force_approve {},
        quest {fail_cards}, lady {holder,target,claim}, assassination {attacker,target}.
        Lady claim can be None (inspect but decline public declaration).
        """
        if not isinstance(event, Mapping) or not isinstance(event.get('kind'), str):
            raise ValueError('Expected an event with kind')
        kind = event['kind']
        fields = {
            'proposal': {'leader', 'team'}, 'vote': {'ballots'}, 'force_approve': set(),
            'quest': {'fail_cards'}, 'lady': {'holder', 'target', 'claim'},
            'assassination': {'attacker', 'target'},
        }
        if kind not in fields or set(event) != fields[kind] | {'kind'}:
            raise ValueError('Unknown event or unexpected fields (possibly private data)')
        n = self.rules.game.player_count
        public: dict = {'seq': len(self.events) + 1, 'kind': kind, 'quest': self.quest}
        if kind == 'proposal':
            if self.phase != 'proposal' or type(event['leader']) is not int or event['leader'] != self._leader:
                raise ValueError('Wrong phase or leader')
            team = event['team']
            if not isinstance(team, (list, tuple)) or len(team) != self.rules.team_size(self.quest) or any(type(x) is not int or not 0 <= x < n for x in team) or len(set(team)) != len(team):
                raise ValueError('Invalid proposed team')
            self._team = tuple(team)
            self.attempts += 1
            self.phase = 'force_approve' if self.attempts == 5 and self.rules.rejection_policy == 'fifth_proposal_forced_approve' else 'vote'
            public.update(leader=self._leader, team=list(team), attempt=self.attempts)
        elif kind == 'vote':
            ballots = event['ballots']
            if self.phase != 'vote' or not isinstance(ballots, Mapping) or set(ballots) != set(range(n)) or any(type(v) is not bool for v in ballots.values()):
                raise ValueError('Vote must include one boolean ballot per seat')
            approvals = sum(ballots.values())
            passed = approvals > n // 2
            public.update(ballots={str(i): ballots[i] for i in range(n)}, approvals=approvals, approved=passed)
            if passed:
                self.attempts = 0
                self.phase = 'quest'
            elif self.attempts == 5:
                self.winner = 'evil'
                self.phase = 'ended'
            else:
                self.phase = 'proposal'
                self._leader = (self._leader + 1) % n
        elif kind == 'force_approve':
            if self.phase != 'force_approve' or self.attempts != 5:
                raise ValueError('Only the fifth proposal can be force-approved')
            public.update(approved=True, forced=True, attempt=5)
            self.attempts = 0
            self.phase = 'quest'
        elif kind == 'quest':
            fails = event['fail_cards']
            max_fails = sum(self.secret_roles[s] in EVIL for s in self._team)
            if self.phase != 'quest' or type(fails) is not int or not 0 <= fails <= max_fails:
                raise ValueError('Invalid quest failure cards or phase')
            inverted = self.rules.nine_player_inverted_protection and self.quest != 4
            passed = (fails != 1) if inverted else (fails < self.rules.fails_required(self.quest))
            self.success_count += passed
            self.failure_count += not passed
            public.update(team=list(self._team), fail_cards=fails, threshold=self.rules.fails_required(self.quest),
                          inverted_protection=inverted, success=passed)
            self._leader = (self._leader + 1) % n
            self._team = ()
            if self.failure_count == 3:
                self.phase, self.winner = 'ended', 'evil'
            elif self.success_count == 3:
                self.phase = 'assassination' if 'Merlin' in self.secret_roles else 'ended'
                if self.phase == 'ended':
                    self.winner = 'good'
            elif self.rules.lady_enabled and self.quest in self.rules.lady_after_quests:
                self.phase = 'lady'
            else:
                self.phase = 'proposal'
            self.quest += 1
        elif kind == 'lady':
            holder, target, claim = event['holder'], event['target'], event['claim']
            if self.phase != 'lady' or type(holder) is not int or type(target) is not int or holder != self._lady_holder or not 0 <= target < n or target in self._lady_used or claim not in ('good', 'evil', None):
                raise ValueError('Invalid Lady holder / target / declaration')
            public.update(holder=holder, target=target, claim=claim)
            self._lady_used.add(target)
            self._lady_holder = target
            self.phase = 'proposal'
        elif kind == 'assassination':
            attacker, target = event['attacker'], event['target']
            if self.phase != 'assassination' or type(attacker) is not int or type(target) is not int or not (0 <= attacker < n and 0 <= target < n) or self.secret_roles[attacker] not in EVIL:
                raise ValueError('Invalid assassination')
            assassin_role = next((r for r in ('Assassin', 'Mordred', 'Morgana') if r in self.secret_roles), None)
            if assassin_role and self.secret_roles[attacker] != assassin_role:
                raise ValueError('Only the designated assassinator can attack')
            hit = self.secret_roles[target] == 'Merlin'
            public.update(attacker=attacker, target=target, hit_merlin=hit)
            self.winner = 'evil' if hit else 'good'
            self.phase = 'ended'
        public['phase_after'] = self.phase
        if self.winner:
            public['winner'] = self.winner
        self.events.append(public)
        return deepcopy(public)

    def public_log(self, through_seq: int | None = None) -> dict:
        """Safe to publish while running; no role assignments or private Lake results."""
        seq = len(self.events) if through_seq is None else through_seq
        if type(seq) is not int or not 0 <= seq <= len(self.events):
            raise ValueError('Invalid cutoff')
        # Only public metadata, not dataclasses.asdict(self).
        return {'schema': self.rules.ruleset_id, 'player_count': self.rules.game.player_count,
                'config': {'rejection_policy': self.rules.rejection_policy,
                           'quest_sizes': [self.rules.team_size(q) for q in range(1, 6)],
                           'fail_thresholds': [self.rules.fails_required(q) for q in range(1, 6)],
                           'lady_enabled': self.rules.lady_enabled,
                           'lady_start_holder': self.rules.lady_start_holder,
                           'lady_after_quests': list(self.rules.lady_after_quests),
                           'first_leader': self.first_leader,
                           'nine_player_inverted_protection': self.rules.nine_player_inverted_protection},
                'events': deepcopy(self.events[:seq])}

    def view_at(self, observer: int, through_seq: int | None = None) -> dict:
        """Authenticated server must bind observer to caller identity.

        A historical snapshot cannot include investigations performed *after*
        the chosen cutoff, even if replayed after the whole game has finished.
        """
        n = self.rules.game.player_count
        if type(observer) is not int or not 0 <= observer < n:
            raise ValueError('Invalid observer')
        base = self.public_log(through_seq)
        private: PrivateInfo = private_view(self.secret_roles, observer)
        base['observer'] = observer
        base['private_info'] = {'seat': private.seat, 'own_role': private.own_role,
                                'merlin_seen_evil': list(private.merlin_seen_evil),
                                'percival_candidates': list(private.percival_candidates),
                                'evil_known_allies': list(private.evil_known_allies)}
        base['my_lady_results'] = [
            {'seq': e['seq'], 'target': e['target'], 'alignment': 'evil' if self.secret_roles[e['target']] in EVIL else 'good'}
            for e in base['events'] if e['kind'] == 'lady' and e['holder'] == observer
        ]
        return base

    def belief_at(self, observer: int, through_seq: int | None = None,
                  sabotage_probability: float = .8) -> Posterior:
        """Connect historical snapshots to the v0.1 exact Bayesian core.

        Only public quest fail counts and the observer's own initial private
        information affect the posterior. Votes, proposal choices, Lady claims
        and speech are intentionally NOT yet assigned likelihoods. This method
        is not a predictor of real-world strategic win rates.
        """
        if self.rules.quest_sizes is not None and any(self.rules.team_size(q) != self.rules.game.mission_size(q) for q in range(1, 6)):
            raise NotImplementedError('Inference core has not learned variant quest sizes')
        snapshot = self.view_at(observer, through_seq)
        evidence = [MissionObservation(e['quest'], tuple(e['team']), e['fail_cards'])
                    for e in snapshot['events'] if e['kind'] == 'quest']
        return infer(self.rules.game, observer=private_view(self.secret_roles, observer),
                     observations=evidence, sabotage_probability=sabotage_probability)

    def reveal_roles(self) -> dict:
        """Full truth only after terminal result; explicit caller authorization required."""
        if self.phase != 'ended':
            raise ValueError('Cannot reveal hidden roles before game ends')
        return {'role_assignments': list(self.secret_roles), 'winner': self.winner}