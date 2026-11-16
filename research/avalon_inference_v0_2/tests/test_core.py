import math
import unittest
from avalon_core import (
    Rules, PrivateInfo, MissionObservation, SoftSignal, infer,
    unique_worlds, private_view, entropy_bits
)

class TestAvalon(unittest.TestCase):
    def test_world_counts(self):
        self.assertEqual(len(list(unique_worlds(Rules.standard(5).roles))), 120)
        self.assertEqual(len(list(unique_worlds(Rules.standard(7).roles))), 2520)
        self.assertEqual(len(list(unique_worlds(Rules.standard(10).roles))), 151200)

    def test_uniform_priors(self):
        b = infer(Rules.standard(5), sabotage_probability=1)
        self.assertEqual(len(b.worlds), 120)
        self.assertAlmostEqual(b.entropy, math.log2(120), places=9)
        for p in b.evil_marginals().values():
            self.assertAlmostEqual(p, 0.4)

    def test_exact_count_information_gain(self):
        b = infer(Rules.standard(5), sabotage_probability=1)
        v = b.mission_value((0,1), 1)
        self.assertAlmostEqual(v['p_mission_success'], .3)
        self.assertAlmostEqual(v['expected_information_gain_bits'], entropy_bits([.3,.6,.1]))
        self.assertAlmostEqual(v['p_fail_cards'][0], .3)
        self.assertAlmostEqual(v['p_fail_cards'][1], .6)
        self.assertAlmostEqual(v['p_fail_cards'][2], .1)

    def test_zero_fail_at_q1_proves_good_team(self):
        b = infer(Rules.standard(5), observations=[MissionObservation(1,(0,1),0)], sabotage_probability=1)
        self.assertEqual(len(b.worlds), 36)
        self.assertAlmostEqual(b.evil_marginals()[0], 0)
        self.assertAlmostEqual(b.evil_marginals()[1], 0)
        self.assertAlmostEqual(sum(b.weights), 1)

    def test_one_fail_means_one_evil_at_q1(self):
        b = infer(Rules.standard(5), observations=[MissionObservation(1,(0,1),1)], sabotage_probability=1)
        self.assertAlmostEqual(b.evil_marginals()[0]+b.evil_marginals()[1],1)

    def test_soft_signal_and_no_reveal(self):
        r = Rules.standard(5)
        b = infer(r, signals=[SoftSignal(0,True,.8,.8)])
        self.assertGreater(b.evil_marginals()[0], .4)
        self.assertLess(b.evil_marginals()[1], .4)

    def test_zero_sabotage_means_zero_mission_ig(self):
        b = infer(Rules.standard(5), sabotage_probability=0)
        self.assertAlmostEqual(b.mission_value((0,1),1)['expected_information_gain_bits'],0)
        self.assertAlmostEqual(b.mission_value((0,1),1)['p_mission_success'],1)

    def test_two_fail_threshold(self):
        b = infer(Rules.standard(7), sabotage_probability=1)
        v = b.mission_value((0,1,2,3),4)
        self.assertEqual(v['fail_threshold'],2)
        self.assertAlmostEqual(v['p_mission_success'],sum(v['p_fail_cards'][:2]))

    def test_view_merlin_mordred_exception(self):
        world = ("Merlin", "Percival", "Servant", "Servant", "Assassin", "Morgana", "Mordred")
        info = private_view(world, 0)
        self.assertEqual(set(info.merlin_seen_evil),{4,5})
        b = infer(Rules.standard(7), observer=info)
        self.assertAlmostEqual(b.evil_marginals()[4],1)
        self.assertAlmostEqual(b.evil_marginals()[5],1)
        self.assertAlmostEqual(b.role_marginals()[6].get("Mordred", 0), .25)

    def test_view_percival_no_distinction(self):
        world = ("Merlin", "Percival", "Servant", "Servant", "Assassin", "Morgana", "Mordred")
        info = private_view(world,1)
        b = infer(Rules.standard(7), observer=info)
        self.assertAlmostEqual(b.role_marginals()[0]["Merlin"],.5)
        self.assertAlmostEqual(b.role_marginals()[5]["Merlin"],.5)

    def test_oberon_is_unseen_by_evil(self):
        world = ("Merlin","Percival","Servant","Servant","Servant","Servant","Assassin","Morgana","Mordred","Oberon")
        info = private_view(world,6)
        self.assertEqual(set(info.evil_known_allies),{7,8})
        b = infer(Rules.standard(10),observer=info)
        self.assertAlmostEqual(b.evil_marginals()[6],1)
        self.assertAlmostEqual(b.evil_marginals()[7],1)
        self.assertAlmostEqual(b.evil_marginals()[8],1)
        self.assertAlmostEqual(b.role_marginals()[9].get('Oberon',0),1/7, places=7)

    def test_inconsistency_detected(self):
        with self.assertRaises(ValueError):
            infer(Rules.standard(5), observations=[MissionObservation(1,(0,1),2),MissionObservation(1,(0,1),0)],sabotage_probability=1)

    def test_10p_mission4_two_fail_regression(self):
        b = infer(Rules.standard(10), sabotage_probability=1)
        v = b.mission_value((0,1,2,3,4),4)
        self.assertEqual(v['fail_threshold'],2)
        self.assertAlmostEqual(v['p_mission_success'],v['p_fail_cards'][0]+v['p_fail_cards'][1])

    def test_entropy_reduction_on_observed_data(self):
        rules = Rules.standard(5)
        prior = infer(rules, sabotage_probability=.8)
        posterior = infer(rules, observations=[MissionObservation(1,(0,1),1)], sabotage_probability=.8)
        self.assertLess(posterior.entropy, prior.entropy)
        self.assertAlmostEqual(sum(posterior.evil_marginals().values()),2)

    def test_reject_invalid_inputs(self):
        with self.assertRaises(ValueError):
            infer(Rules.standard(5),observations=[MissionObservation(1,(0,0),1)])
        with self.assertRaises(ValueError):
            infer(Rules.standard(5),observer=PrivateInfo(0,'Servant',merlin_seen_evil=(2,)))

if __name__ == '__main__':
    unittest.main()