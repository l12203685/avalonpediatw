"""第 50 回合：`fitRound50.ts --out rows.csv` 的殘差擬合（第 47 回合的做法）。

logit P(紅) = b0 + a·logit(預設後驗 p) + w_prop·提議不合理度 + w_tail·強制局不合理度 + w_lake·湖的不合理度，
numpy 牛頓法；區間 = 以局為單位的集群自助法（同一局的點不獨立）。分強者桌（S ≥ 55）與全部真人；另外報一次只用一個特徵的擬合。

    python3 scripts/fitRound50.py rows.csv [boots=300]
"""
import sys
import numpy as np


def logistic(X, y, iters=50):
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        z = X @ b
        p = 1 / (1 + np.exp(-z))
        g = X.T @ (y - p)
        H = -(X.T * (p * (1 - p))) @ X
        step = np.linalg.solve(H, g)
        b -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return b


def design(d, cols):
    p = np.clip(d['p'], 1e-6, 1 - 1e-6)
    xs = [np.ones(len(p)), np.log(p / (1 - p))] + [d[c] for c in cols]
    return np.column_stack(xs)


def fit(d, cols, boots, rng):
    X = design(d, cols)
    y = d['red']
    b = logistic(X, y)
    games = np.unique(d['g'])
    idx_by = {g: np.nonzero(d['g'] == g)[0] for g in games}
    bs = []
    for _ in range(boots):
        pick = rng.choice(games, size=len(games), replace=True)
        ii = np.concatenate([idx_by[g] for g in pick])
        bs.append(logistic(X[ii], y[ii]))
    bs = np.array(bs)
    lo = np.percentile(bs, 2.5, axis=0)
    hi = np.percentile(bs, 97.5, axis=0)
    return b, lo, hi


def main():
    path = sys.argv[1]
    boots = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    raw = np.genfromtxt(path, delimiter=',', names=True)
    rng = np.random.default_rng(50)
    names = ['b0', 'a', 'prop', 'tail', 'lake']
    for label, mask in [('strong', raw['strong'] == 1), ('all', np.ones(len(raw), bool))]:
        d = raw[mask]
        print(f'== {label}: {len(d)} points, {len(np.unique(d["g"]))} games, red share {d["red"].mean():.3f}')
        b, lo, hi = fit(d, ['prop', 'tail', 'lake'], boots, rng)
        for k, nm in enumerate(names):
            print(f'  {nm:5s} {b[k]:+.3f} [{lo[k]:+.3f}, {hi[k]:+.3f}]')
        for c in ['prop', 'tail', 'lake']:
            b1, lo1, hi1 = fit(d, [c], boots // 3, rng)
            print(f'  only {c}: {b1[2]:+.3f} [{lo1[2]:+.3f}, {hi1[2]:+.3f}]  (a {b1[1]:.3f})')
        for c in ['prop', 'tail', 'lake']:
            x = d[c]
            print(f'  {c}: mean red {x[d["red"] == 1].mean():.3f} / blue {x[d["red"] == 0].mean():.3f}; nonzero {np.mean(x > 0):.3f}')


if __name__ == '__main__':
    main()
