"""Sensitivity analysis of a single public mission observation. No backtest."""
import csv
from pathlib import Path
from avalon_core import Rules, PrivateInfo, MissionObservation, infer

rows=[]
for q in (0.2,0.4,0.6,0.8,1.0):
    p=infer(Rules.standard(10), observer=PrivateInfo(0, 'Servant'),
            observations=[MissionObservation(1,(3,5,7),1)], sabotage_probability=q)
    m=p.evil_marginals()
    rows.append({'sabotage_probability':q, 'p_evil_3':m[3],
                 'p_evil_1':m[1], 'entropy_bits':p.entropy,
                 'retained_hypotheses':len(p.worlds)})

out=Path(__file__).resolve().parent/'results'/'sabotage_sensitivity.csv'
with out.open('w',encoding='utf-8-sig',newline='') as f:
    writer=csv.DictWriter(f, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
for r in rows:
    print({k:round(v,6) if isinstance(v,float) else v for k,v in r.items()})