import json
import unittest
from avalon_core import Rules
from event_replay import Replay, ReplayRules

FIVE = ('Merlin', 'Percival', 'Servant', 'Assassin', 'Morgana')
TEN = ('Merlin', 'Percival', 'Servant', 'Servant', 'Servant', 'Servant', 'Assassin', 'Morgana', 'Mordred', 'Oberon')


def approve(n, yes=True):
    return {'kind': 'vote', 'ballots': {i: yes for i in range(n)}}


def add_quest(replay, team, fails=0, force=False):
    replay.apply({'kind': 'proposal', 'leader': replay._leader, 'team': team})
    replay.apply({'kind': 'force_approve'} if force else approve(replay.rules.game.player_count))
    replay.apply({'kind': 'quest', 'fail_cards': fails})


class TestReplay(unittest.TestCase):
    def test_platform_defaults(self):
        cfg = ReplayRules.platform_10p()
        self.assertEqual(cfg.rejection_policy, 'fifth_proposal_forced_approve')
        self.assertEqual(cfg.lady_start_holder, 9)
        self.assertEqual(cfg.team_size(1), 3)
        self.assertEqual(cfg.fails_required(4), 2)

    def test_rules_version_and_variants(self):
        rule = ReplayRules(Rules.standard(9), ruleset_id='9p-oberon-mandatory', quest_sizes=(4, 3, 4, 5, 5), quest4_fails_required=2)
        self.assertEqual(rule.team_size(1), 4)
        self.assertEqual(rule.team_size(2), 3)
        self.assertEqual(rule.fails_required(4), 2)
        with self.assertRaises(ValueError):
            ReplayRules(Rules.standard(5), lady_enabled=True, lady_start_holder=0)
        with self.assertRaises(ValueError):
            ReplayRules(Rules.standard(5), rejection_policy='unknown')

    def test_full_lifecycle_good_wins_after_missed_assassination(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        for team in [(0, 1), (0, 1, 2), (0, 2)]:
            add_quest(game, team)
        self.assertEqual(game.phase, 'assassination')
        self.assertEqual(game.success_count, 3)
        game.apply({'kind': 'assassination', 'attacker': 3, 'target': 1})
        self.assertEqual(game.winner, 'good')
        self.assertEqual(game.reveal_roles()['role_assignments'][0], 'Merlin')

    def test_assassination_hit_and_terminal_guard(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        with self.assertRaises(ValueError):
            game.reveal_roles()
        with self.assertRaises(ValueError):
            game.apply({'kind': 'assassination', 'attacker': 3, 'target': 0})
        for team in [(0, 1), (0, 1, 2), (0, 2)]:
            add_quest(game, team)
        game.apply({'kind': 'assassination', 'attacker': 3, 'target': 0})
        self.assertEqual(game.winner, 'evil')
        with self.assertRaises(ValueError):
            game.apply({'kind': 'proposal', 'leader': 3, 'team': [3, 4]})

    def test_5_consecutive_rejections_evil_wins(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        for leader in range(5):
            game.apply({'kind': 'proposal', 'leader': leader, 'team': [0, 1]})
            game.apply(approve(5, False))
        self.assertEqual(game.winner, 'evil')
        self.assertEqual(game.phase, 'ended')
        self.assertEqual(game.quest, 1)

    def test_platform_fifth_forced_and_no_ballots(self):
        game = Replay(ReplayRules(Rules.standard(5)), FIVE)
        for leader in range(4):
            game.apply({'kind': 'proposal', 'leader': leader, 'team': [0, 1]})
            game.apply(approve(5, False))
        game.apply({'kind': 'proposal', 'leader': 4, 'team': [0, 1]})
        self.assertEqual(game.phase, 'force_approve')
        with self.assertRaises(ValueError):
            game.apply(approve(5, False))
        game.apply({'kind': 'force_approve'})
        self.assertEqual(game.phase, 'quest')
        game.apply({'kind': 'quest', 'fail_cards': 0})
        self.assertEqual(game.quest, 2)

    def test_vote_majority_not_tie(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        game.apply({'kind': 'proposal', 'leader': 0, 'team': [0, 1]})
        ballots = {0: True, 1: True, 2: False, 3: False, 4: False}
        game.apply({'kind': 'vote', 'ballots': ballots})
        self.assertEqual(game.phase, 'proposal')
        self.assertEqual(game.attempts, 1)
        self.assertEqual(game._leader, 1)

    def test_lady_public_claim_private_truth_and_historical_cutoff(self):
        game = Replay(ReplayRules.platform_10p(lady_start_holder=9), TEN)
        add_quest(game, [0, 1, 2])
        add_quest(game, [0, 1, 2, 3])
        self.assertEqual(game.phase, 'lady')
        seq_before = len(game.events)
        game.apply({'kind': 'lady', 'holder': 9, 'target': 7, 'claim': 'good'})
        public = json.dumps(game.public_log())
        self.assertNotIn('Morgana', public)
        self.assertNotIn('alignment', public)
        self.assertEqual(game.view_at(9)['my_lady_results'][-1]['alignment'], 'evil')
        self.assertEqual(game.view_at(7)['my_lady_results'], [])
        self.assertEqual(game.view_at(9, seq_before)['my_lady_results'], [])
        self.assertEqual(game.view_at(0)['private_info']['merlin_seen_evil'], [6, 7, 9])
        self.assertEqual(game.view_at(1)['private_info']['percival_candidates'], [0, 7])
        self.assertEqual(game.view_at(6)['private_info']['evil_known_allies'], [7, 8])
        self.assertEqual(game.view_at(8)['private_info']['evil_known_allies'], [6, 7])
        self.assertEqual(game.view_at(9)['private_info']['evil_known_allies'], [])
        self.assertEqual(game.view_at(2)['private_info']['merlin_seen_evil'], [])
        # Claim can be a lie: no hard identity inference is made from it.
        self.assertEqual(game.events[-1]['claim'], 'good')
        with self.assertRaises(ValueError):
            game.apply({'kind': 'lady', 'holder': 7, 'target': 9, 'claim': 'evil'})

    def test_lady_next_holder_and_no_repeat_targets(self):
        game = Replay(ReplayRules.platform_10p(), TEN)
        add_quest(game, [0, 1, 2])
        add_quest(game, [0, 1, 2, 3])
        game.apply({'kind': 'lady', 'holder': 9, 'target': 6, 'claim': 'evil'})
        add_quest(game, [6, 7, 2, 3], fails=1)  # 1 fail; quest 3 ends but game continues
        self.assertEqual(game.phase, 'lady')
        with self.assertRaises(ValueError):
            game.apply({'kind': 'lady', 'holder': 6, 'target': 9, 'claim': 'evil'})
        game.apply({'kind': 'lady', 'holder': 6, 'target': 8, 'claim': 'good'})
        self.assertEqual(game.phase, 'proposal')

    def test_fourth_quest_two_fail_cards(self):
        game = Replay(ReplayRules.platform_10p(), TEN)
        add_quest(game, [0, 1, 2])
        add_quest(game, [0, 1, 2, 3])
        game.apply({'kind': 'lady', 'holder': 9, 'target': 2, 'claim': 'good'})
        add_quest(game, [6, 7, 3, 4], fails=1)
        game.apply({'kind': 'lady', 'holder': 2, 'target': 3, 'claim': 'good'})
        add_quest(game, [6, 7, 8, 2, 3], fails=1)
        self.assertEqual(game.failure_count, 1)
        self.assertEqual(game.success_count, 3)
        self.assertEqual(game.phase, 'assassination')

    def test_no_hidden_fields_and_atomic_rejection(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        for event in [
            {'kind': 'proposal', 'leader': 0, 'team': [0, 1], 'world': FIVE},
            {'kind': 'proposal', 'leader': 0, 'team': [0, 0]},
            {'kind': 'proposal', 'leader': 1, 'team': [0, 1]},
            {'kind': 'quest', 'fail_cards': 0},
        ]:
            with self.assertRaises(ValueError):
                game.apply(event)
        self.assertEqual(len(game.events), 0)
        self.assertEqual(game.quest, 1)
        self.assertEqual(game.phase, 'proposal')
        with self.assertRaises(ValueError):
            game.public_log(100)
        with self.assertRaises(ValueError):
            game.view_at(999)

    def test_quest_failure_not_exceed_evil_seats(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        game.apply({'kind': 'proposal', 'leader': 0, 'team': [0, 1]})
        game.apply(approve(5))
        with self.assertRaises(ValueError):
            game.apply({'kind': 'quest', 'fail_cards': 1})
        self.assertEqual(game.phase, 'quest')
        self.assertEqual(len(game.events), 2)

    def test_bad_ballots_are_rejected(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        game.apply({'kind': 'proposal', 'leader': 0, 'team': [0, 1]})
        with self.assertRaises(ValueError):
            game.apply({'kind': 'vote', 'ballots': {i: True for i in range(4)}})
        with self.assertRaises(ValueError):
            game.apply({'kind': 'vote', 'ballots': {i: 1 for i in range(5)}})
        self.assertEqual(game.phase, 'vote')
        self.assertEqual(len(game.events), 1)

    def test_nine_player_inverted_protection(self):
        roles = ('Merlin', 'Percival', 'Servant', 'Servant', 'Servant',
                 'Assassin', 'Morgana', 'Mordred', 'Oberon')
        cfg = ReplayRules(Rules(9, roles), quest_sizes=(4, 3, 4, 5, 5),
                          nine_player_inverted_protection=True)
        game = Replay(cfg, roles)
        add_quest(game, [5, 6, 0, 1], fails=2)
        self.assertEqual(game.success_count, 1)  # 2 fail cards still succeeds in this opt-in variant
        self.assertTrue(game.events[-1]['inverted_protection'])
        add_quest(game, [5, 0, 1], fails=1)
        self.assertEqual(game.failure_count, 1)
        with self.assertRaises(ValueError):
            ReplayRules(Rules.standard(10), nine_player_inverted_protection=True)

    def test_lady_may_decline_to_declare(self):
        game = Replay(ReplayRules.platform_10p(), TEN)
        add_quest(game, [0, 1, 2])
        add_quest(game, [0, 1, 2, 3])
        game.apply({'kind': 'lady', 'holder': 9, 'target': 7, 'claim': None})
        self.assertIsNone(game.public_log()['events'][-1]['claim'])
        self.assertEqual(game.view_at(9)['my_lady_results'][0]['alignment'], 'evil')
        self.assertEqual(game.view_at(0)['my_lady_results'], [])

    def test_assassin_role_required_even_if_other_evil_attacks(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        for team in [(0, 1), (0, 1, 2), (0, 2)]:
            add_quest(game, team)
        with self.assertRaises(ValueError):
            game.apply({'kind': 'assassination', 'attacker': 4, 'target': 0})
        self.assertEqual(game.phase, 'assassination')

    def test_exported_config_is_versioned_and_public(self):
        game = Replay(ReplayRules.platform_10p(), TEN)
        cfg = game.public_log()['config']
        self.assertEqual(cfg['quest_sizes'], [3, 4, 4, 5, 5])
        self.assertEqual(cfg['fail_thresholds'], [1, 1, 1, 2, 1])
        self.assertEqual(cfg['rejection_policy'], 'fifth_proposal_forced_approve')
        self.assertNotIn('secret_roles', json.dumps(game.public_log()))

    def test_history_cutoff_changes_belief_only_when_evidence_is_visible(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        prior = game.belief_at(2, sabotage_probability=1)
        self.assertAlmostEqual(prior.evil_marginals()[3], .5)
        game.apply({'kind': 'proposal', 'leader': 0, 'team': [2, 3]})
        game.apply(approve(5))
        cutoff = len(game.events)
        game.apply({'kind': 'quest', 'fail_cards': 1})
        before = game.belief_at(2, cutoff, sabotage_probability=1)
        after = game.belief_at(2, sabotage_probability=1)
        self.assertAlmostEqual(before.evil_marginals()[3], .5)
        self.assertAlmostEqual(after.evil_marginals()[3], 1)
        self.assertNotIn('secret_roles', repr(game))

    def test_inference_refuses_nonstandard_quest_sizes(self):
        roles = ('Merlin', 'Percival', 'Servant', 'Servant', 'Servant',
                 'Assassin', 'Morgana', 'Mordred', 'Oberon')
        cfg = ReplayRules(Rules(9, roles), quest_sizes=(4, 3, 4, 5, 5))
        with self.assertRaises(NotImplementedError):
            Replay(cfg, roles).belief_at(2)

    def test_published_log_does_not_alias_mutable_records(self):
        game = Replay(ReplayRules.official_style(5), FIVE)
        game.apply({'kind': 'proposal', 'leader': 0, 'team': [0, 1]})
        exported = game.public_log()
        exported['events'][0]['team'][0] = 3
        self.assertEqual(game.events[0]['team'], [0, 1])


if __name__ == '__main__':
    unittest.main()