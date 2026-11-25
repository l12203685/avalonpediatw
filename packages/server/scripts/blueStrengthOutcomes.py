#!/usr/bin/env python3
"""第 79 回合（站長 2026-11-25「先把藍方平均強度夠高的那幾局抓出來 再重算任務結果分布（三紅/三藍）跟遊戲結果分佈（三紅/三藍死/三藍活）」）：
真人局照藍方、紅方各自的平均 PR 分組，算結果分布。

  python3 scripts/blueStrengthOutcomes.py [games_cache.json]

輸入＝網站數據分析的 games_cache.json（每個座位開打前的 PR 來自快取的 lineup 欄；藍方平均＝6 個藍方座位 PR 的平均、紅方平均＝4 個紅方座位）。
只算線瓦／面瓦、結果已知的 10 人局。輸出只有合計數字（局數、三紅／三藍死／三藍活、任務三藍、刺中率），沒有玩家名。
機器人互打兩邊一樣強，所以公平的參考是「藍 ≥ 55 且 紅 ≥ 55」（兩邊都夠強的局）。
"""
import json, sys, math, os
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'games_cache.json')
d = json.load(open(path, encoding='utf-8'))
F=d['fields']; V=d['vocab']; seats=d['constants']['seats']
ix={f:i for i,f in enumerate(F)}
rows=[]
for g in d['games']:
    lu=g[ix['lineup']]
    if not lu: continue
    cat=V['category'][g[ix['cat']]]; out=V['outcome'][g[ix['outcome']]]
    if cat not in ('線瓦','面瓦') or out not in ('三紅','三藍死','三藍活'): continue
    cfg=g[ix['config']]
    if len(cfg)!=6: continue
    red=set(cfg[:4]); 
    prs=lu[2]; provmask=lu[3]
    bi=[k for k,s in enumerate(seats) if s not in red]; ri=[k for k,s in enumerate(seats) if s in red]
    if len(bi)!=6: continue
    b=sum(prs[k] for k in bi)/6; r=sum(prs[k] for k in ri)/4; s=sum(prs)/10
    nprov_b=sum(1 for k in bi if provmask>>k &1)
    rows.append((b,r,s,out,nprov_b))
def dist(sel):
    n=len(sel); 
    if n==0: return None
    c={o:sum(1 for x in sel if x[3]==o) for o in ('三紅','三藍死','三藍活')}
    m3=(c['三藍死']+c['三藍活'])/n
    hit=c['三藍死']/max(1,c['三藍死']+c['三藍活'])
    se=math.sqrt(c['三藍活']/n*(1-c['三藍活']/n)/n)
    return n,100*c['三紅']/n,100*c['三藍死']/n,100*c['三藍活']/n,100*m3,100*hit,100*se
print('all',len(rows))
print('filter | n | 三紅 | 三藍死 | 三藍活(±se) | 任務三藍 | 刺中率')
def show(name,sel):
    r=dist(sel)
    if r: print(f"{name} | {r[0]} | {r[1]:.1f} | {r[2]:.1f} | {r[3]:.1f} ±{r[6]:.1f} | {r[4]:.1f} | {r[5]:.1f}")
show('全部',rows)
for t in (50,55,60,65,70):
    show(f'藍方平均PR≥{t}',[x for x in rows if x[0]>=t])
for t in (55,60,65):
    show(f'藍方≥{t} 且 藍方沒有暫定',[x for x in rows if x[0]>=t and x[4]==0])
for t in (55,60):
    show(f'全桌S≥{t}',[x for x in rows if x[2]>=t])
for t in (55,60):
    show(f'藍≥{t} 且 紅≥{t}',[x for x in rows if x[0]>=t and x[1]>=t])
for t in (55,60,65):
    show(f'藍≥{t} 且 紅<{t}',[x for x in rows if x[0]>=t and x[1]<t])
