"""Run reproducible demos. No external packages required.

python demo.py --case five
python demo.py --case 357
"""
import argparse
import json
from pathlib import Path
from avalon_core import Rules, PrivateInfo, MissionObservation, infer, rank_teams

BASE = Path(__file__).resolve().parent

def as_floats(data):
    if isinstance(data, dict):
        return {str(k): as_floats(v) for k, v in data.items()}
    if isinstance(data, list):
        return [as_floats(v) for v in data]
    if isinstance(data, float):
        return round(data, 8)
    return data


def run_five():
    rules = Rules.standard(5)
    post = infer(rules, sabotage_probability=1.0)
    prior = {"hypotheses": len(post.worlds), "entropy_bits": post.entropy,
             "evil_marginals": post.evil_marginals(), "team_01": post.mission_value((0,1),1)}
    after = infer(rules, observations=[MissionObservation(1,(0,1),0)], sabotage_probability=1.0)
    return {"label": "five-player exact-count worked example", "prior": prior,
            "after_zero_fail_cards": {"hypotheses": len(after.worlds), "entropy_bits": after.entropy,
                                      "evil_marginals": after.evil_marginals()},
            "note": "Synthetically assumes every evil player sabotages (q=1); not empirical win-rate."}


def run_357():
    rules = Rules.standard(10)
    # Public round-1 357 with exactly one fail card, plus hypothetical seat-0 Servant self knowledge.
    view = PrivateInfo(seat=0, own_role="Servant")
    post = infer(rules, observer=view, observations=[MissionObservation(1,(3,5,7),1)], sabotage_probability=.8)
    rankings = rank_teams(post, 2, top_n=4)
    return {"label": "ten-player 357 one-fail educational baseline", "assumptions": {
        "viewer": "seat 0, Servant (hypothetical)", "sabotage_probability": .8,
        "mission_1_team": [3,5,7], "revealed_fail_cards": 1,
        "mission_2_round_no": 2,
        "not_inferred": "Dialog, accusations and proposal/voting behavior intentionally excluded"},
        "posterior": {"hypotheses": len(post.worlds), "entropy_bits": post.entropy,
                      "evil_marginals": post.evil_marginals()},
        "round2_rankings": rankings,
        "note": "No actual player identity is claimed; permutations of seats 3/5/7 are symmetric without further evidence."}

if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--case", choices=["five", "357", "all"], default="all")
    cli.add_argument("--out", default="", help="Optional JSON output file")
    args = cli.parse_args()
    result = {"five":run_five,"357":run_357}
    chosen = [args.case] if args.case != "all" else ["five","357"]
    data = as_floats({k: result[k]() for k in chosen})
    output = json.dumps(data, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output + "\n", encoding="utf-8")
    print(output)