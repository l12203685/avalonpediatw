"""Command line interface for a versioned public/private observation JSON case.

Example: python analyze.py --input examples/ten_357.json --out results/ten_357.json
"""
import argparse
import json
from pathlib import Path
from avalon_core import Rules, PrivateInfo, MissionObservation, SoftSignal, infer, rank_teams


def read_case(raw):
    rules = Rules.standard(raw['player_count'])
    info = PrivateInfo(**raw['observer']) if raw.get('observer') is not None else None
    observations = [MissionObservation(round_no=o['round_no'], team=tuple(o['team']), fail_cards=o['fail_cards']) for o in raw.get('missions', [])]
    signals = [SoftSignal(**s) for s in raw.get('soft_signals', [])]
    q = float(raw.get('sabotage_probability', .8))
    return rules, info, observations, signals, q


def analyze(raw):
    rules, info, missions, signals, q = read_case(raw)
    post = infer(rules, observer=info, observations=missions, signals=signals, sabotage_probability=q)
    round_no = raw.get('evaluate_round', len(missions)+1)
    if not 1 <= round_no <= 5:
        raise ValueError('evaluate_round must be 1..5')
    rankings = rank_teams(post, round_no, raw.get('top_n', 5))
    return {'model_version': '0.1.0', 'player_count': rules.player_count,
            'observation_count': len(missions), 'soft_signal_count':len(signals),
            'sabotage_probability':q, 'posterior_hypotheses':len(post.worlds),
            'entropy_bits':post.entropy,
            'evil_marginals':post.evil_marginals(),
            'role_marginals':post.role_marginals(), 'rankings':rankings,
            'disclaimers':[
               'All likelihoods are conditional on independent sabotage probability q.',
               'Proposals, public voting, and language are not modeled unless explicitly supplied as soft signals.',
               'Soft signals are assumed conditionally independent; correlated cues must not be entered separately without calibration.',
               'Ranking by p(success) or expected information gain is not a complete win-rate optimum.',
               'Private observer data must originate from a trusted server in real use.'
            ]}

if __name__ == '__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=False)
    args=ap.parse_args()
    raw=json.loads(Path(args.input).read_text(encoding='utf-8'))
    result=analyze(raw)
    txt=json.dumps(result,ensure_ascii=False,indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True,exist_ok=True)
        Path(args.out).write_text(txt+'\n',encoding='utf-8')
    print(txt)