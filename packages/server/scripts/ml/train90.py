#!/usr/bin/env python3
"""第 90 回合（路線圖 Phase C，Issue #215）：離線訓練兩顆小模型，匯出純 JSON 給 TypeScript（`src/ai/ml/mlModel90.ts`）推論。

只用 numpy（這台機器沒有 sklearn）。模型 = 淺的梯度提升樹（直方圖切點、Newton 葉子值、列抽樣），或線性 logit；
分數可以加一個「起點」特徵（係數 1），例如現行信念的 logit——樹只學「現行沒有寫到的修正」。

  第 1 號（誰是紅，二元）：
    python3 scripts/ml/train90.py belief --data b90_0.bin b90_1.bin --out src/ai/ml/belief90.json [--mode stack|pure] [--trees 300 ...]
  第 2 號（刺殺候選人裡誰是梅林，一組取 softmax）：
    python3 scripts/ml/train90.py assassin --human a90h.jsonl --bot a90b_583.jsonl a90b_588.jsonl --out src/ai/ml/assassin90.json [...]

資料由 `scripts/ml/exportBelief90.ts`／`scripts/ml/exportAssassin90.ts` 產生（只有座位、角色、特徵，沒有玩家名）。
時間切分：真人局照日期排序，前 2/3 擬合、後 1/3 驗證（`late` = 1）；擬合那一半裡再用局序號 mod 5 == 0 的局決定樹要幾棵（提早停）。
全部決定論（固定種子）。輸出的 JSON 記資料、切分、超參數與樣本外分數。
"""
import argparse
import json
import math
import sys

import numpy as np

NBINS = 64


# ─── 資料 ────────────────────────────────────────────────────────────────────

def load_bin(paths):
    mats, cols = [], None
    for p in paths:
        meta = json.load(open(p[:-4] + '.json', encoding='utf8'))
        c = meta['cols']
        if cols is None:
            cols = c
        elif cols != c:
            raise SystemExit(f'column mismatch in {p}')
        a = np.fromfile(p, dtype=np.float32)
        mats.append(a.reshape(-1, len(c)))
    return cols, np.concatenate(mats, axis=0)


# ─── 直方圖切點 ──────────────────────────────────────────────────────────────

def make_bins(X):
    """每個特徵的切點（相鄰分位數的中點）與分箱後的 uint8 矩陣：x ≤ T[b] 的最小 b。"""
    th = []
    B = np.zeros(X.shape, dtype=np.uint8)
    for f in range(X.shape[1]):
        x = X[:, f].astype(np.float64)
        uq = np.unique(np.quantile(x, np.linspace(0, 1, NBINS + 1)))
        if len(uq) < 2:
            th.append(np.zeros(0))
            continue
        # 少量不同值的特徵（計數）：用每一個不同值的中點
        vals = np.unique(x)
        if len(vals) <= NBINS:
            uq = vals
        t = (uq[:-1] + uq[1:]) / 2.0
        th.append(t)
        B[:, f] = np.searchsorted(t, x, side='left').astype(np.uint8)
    return th, B


def apply_bins(th, X):
    B = np.zeros(X.shape, dtype=np.uint8)
    for f, t in enumerate(th):
        if len(t):
            B[:, f] = np.searchsorted(t, X[:, f].astype(np.float64), side='left').astype(np.uint8)
    return B


# ─── 梯度 ────────────────────────────────────────────────────────────────────

def sigmoid(z):
    return np.where(z >= 0, 1 / (1 + np.exp(-np.clip(z, -50, 50))), np.exp(np.clip(z, -50, 50)) / (1 + np.exp(np.clip(z, -50, 50))))


def group_softmax(z, gid):
    """z: 分數；gid: 每列的組號（0..G-1，同組連續或不連續都可以）。"""
    G = gid.max() + 1
    m = np.full(G, -np.inf)
    np.maximum.at(m, gid, z)
    e = np.exp(z - m[gid])
    s = np.bincount(gid, weights=e, minlength=G)
    return e / s[gid]


def grad_hess(objective, z, y, gid, w):
    if objective == 'binary':
        p = sigmoid(z)
    else:
        p = group_softmax(z, gid)
    g = (p - y) * w
    h = np.maximum(p * (1 - p), 1e-6) * w
    return g, h


def loss(objective, z, y, gid, w):
    if objective == 'binary':
        p = np.clip(sigmoid(z), 1e-6, 1 - 1e-6)
        return float(-(w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum() / w.sum())
    p = np.clip(group_softmax(z, gid), 1e-12, 1)
    return float(-(w * y * np.log(p)).sum() / (w * y).sum())


# ─── 一棵樹 ──────────────────────────────────────────────────────────────────

def build_tree(B, g, h, rows, allowed, depth, lam, min_hess, th, lr):
    """回傳平行陣列的樹（f, t, l, r, v）。只在 `allowed` 的特徵上切。"""
    F = B.shape[1]
    nodes = []  # dict(f, t, l, r, v)

    def leaf(gs, hs):
        nodes.append({'f': -1, 't': 0.0, 'l': -1, 'r': -1, 'v': float(-lr * gs / (hs + lam))})
        return len(nodes) - 1

    def grow(idx, d):
        gs, hs = g[idx].sum(), h[idx].sum()
        if d >= depth or len(idx) < 2 or hs < 2 * min_hess:
            return leaf(gs, hs)
        sub = B[idx][:, allowed].astype(np.int64)
        off = (np.arange(len(allowed)) * NBINS)[None, :]
        flat = (sub + off).ravel()
        GH = np.bincount(flat, weights=np.repeat(g[idx], len(allowed)), minlength=len(allowed) * NBINS).reshape(len(allowed), NBINS)
        HH = np.bincount(flat, weights=np.repeat(h[idx], len(allowed)), minlength=len(allowed) * NBINS).reshape(len(allowed), NBINS)
        GL = np.cumsum(GH, axis=1)[:, :-1]
        HL = np.cumsum(HH, axis=1)[:, :-1]
        GR = gs - GL
        HR = hs - HL
        ok = (HL >= min_hess) & (HR >= min_hess)
        gain = np.where(ok, GL ** 2 / (HL + lam) + GR ** 2 / (HR + lam) - gs ** 2 / (hs + lam), -np.inf)
        # 切點只能在那個特徵實際有的切點範圍內
        for a, f in enumerate(allowed):
            nt = len(th[f])
            if nt < NBINS - 1:
                gain[a, nt:] = -np.inf
        k = int(np.argmax(gain))
        a, b = divmod(k, NBINS - 1)
        if not np.isfinite(gain[a, b]) or gain[a, b] <= 1e-9:
            return leaf(gs, hs)
        f = allowed[a]
        me = len(nodes)
        nodes.append({'f': int(f), 't': float(th[f][b]), 'l': -1, 'r': -1, 'v': 0.0})
        left = idx[B[idx, f] <= b]
        right = idx[B[idx, f] > b]
        nodes[me]['l'] = grow(left, d + 1)
        nodes[me]['r'] = grow(right, d + 1)
        return me

    grow(rows, 0)
    return {k: [n[k] for n in nodes] for k in ('f', 't', 'l', 'r', 'v')}


def tree_predict(tree, X):
    f, t, l, r, v = (np.array(tree[k]) for k in ('f', 't', 'l', 'r', 'v'))
    node = np.zeros(len(X), dtype=np.int64)
    for _ in range(64):
        fi = f[node]
        live = fi >= 0
        if not live.any():
            break
        xv = X[np.arange(len(X)), np.where(live, fi, 0)]
        nxt = np.where(xv > t[node], r[node], l[node])
        node = np.where(live, nxt, node)
    return v[node]


def boost(X, y, gid, w, train, valid, objective, allowed, offset, trees, depth, lr, lam, min_hess, subsample, seed, init=None, log=True):
    """梯度提升；`valid` 的損失決定留幾棵樹（之後不再改善 40 棵就停）。"""
    rng = np.random.default_rng(seed)
    th, B = make_bins(X[train])
    Ball = apply_bins(th, X)
    base = X[:, offset].astype(np.float64) if offset >= 0 else np.zeros(len(X))
    if init is None:
        if objective == 'binary' and offset < 0:
            m = float((y[train] * w[train]).sum() / w[train].sum())
            init = math.log(m / (1 - m))
        else:
            init = 0.0
    z = base + init
    out = []
    best, best_n, best_loss = None, 0, loss(objective, z[valid], y[valid], remap(gid, valid), w[valid])
    if log:
        print(f'  init valid loss {best_loss:.5f}', file=sys.stderr)
    tr_idx = np.where(train)[0]
    for it in range(trees):
        g, h = grad_hess(objective, z, y, gid, w)
        if subsample < 1:
            if objective == 'group':
                gs = np.unique(gid[tr_idx])
                keep = rng.random(gid.max() + 1) < subsample
                rows = tr_idx[keep[gid[tr_idx]]]
            else:
                rows = tr_idx[rng.random(len(tr_idx)) < subsample]
        else:
            rows = tr_idx
        tree = build_tree(Ball, g, h, rows, allowed, depth, lam, min_hess, th, lr)
        out.append(tree)
        z = z + tree_predict(tree, X)
        vl = loss(objective, z[valid], y[valid], remap(gid, valid), w[valid])
        if vl < best_loss - 1e-7:
            best_loss, best_n = vl, len(out)
        if log and (it + 1) % 25 == 0:
            print(f'  tree {it + 1}: valid loss {vl:.5f} (best {best_loss:.5f} @ {best_n})', file=sys.stderr)
        if len(out) - best_n >= 40:
            break
    return out[:best_n], init


def remap(gid, mask):
    """一個子集的組號重新編成 0..G'-1。"""
    sub = gid[mask]
    _, inv = np.unique(sub, return_inverse=True)
    return inv


def predict(trees, init, X, offset):
    z = (X[:, offset].astype(np.float64) if offset >= 0 else np.zeros(len(X))) + init
    for t in trees:
        z = z + tree_predict(t, X)
    return z


# ─── 分數與信賴區間（以局為集群的重抽） ───────────────────────────────────────

def binary_metrics_by_game(p, y, gi):
    """每一局的 Brier、對數損失總和、點數，與 10 格可靠度圖的累加（給 ECE 重抽用）。"""
    p = np.clip(p, 1e-6, 1 - 1e-6)
    games, inv = np.unique(gi, return_inverse=True)
    G = len(games)
    br = np.bincount(inv, weights=(p - y) ** 2, minlength=G)
    ll = np.bincount(inv, weights=-(y * np.log(p) + (1 - y) * np.log(1 - p)), minlength=G)
    n = np.bincount(inv, minlength=G).astype(float)
    b = np.minimum((p * 10).astype(int), 9)
    cell = inv * 10 + b
    cn = np.bincount(cell, minlength=G * 10).reshape(G, 10)
    cp = np.bincount(cell, weights=p, minlength=G * 10).reshape(G, 10)
    cy = np.bincount(cell, weights=y, minlength=G * 10).reshape(G, 10)
    return {'br': br, 'll': ll, 'n': n, 'cn': cn, 'cp': cp, 'cy': cy}


def agg(m, wts=None):
    if wts is None:
        wts = np.ones(len(m['n']))
    n = (wts * m['n']).sum()
    cn = (wts[:, None] * m['cn']).sum(0)
    cp = (wts[:, None] * m['cp']).sum(0)
    cy = (wts[:, None] * m['cy']).sum(0)
    ece = float(np.abs(cp - cy).sum() / n)
    return {'brier': float((wts * m['br']).sum() / n), 'logloss': float((wts * m['ll']).sum() / n), 'ece': ece, 'n': int(round(n))}


def compare(ms, names, B=1000, seed=90):
    """幾組預測（同一批點）的分數、和第一組的差與 95% 重抽信賴區間（以局為集群）。"""
    rng = np.random.default_rng(seed)
    G = len(ms[0]['n'])
    pts = [agg(m) for m in ms]
    boots = [[] for _ in ms]
    for _ in range(B):
        wts = np.bincount(rng.integers(0, G, G), minlength=G).astype(float)
        for i, m in enumerate(ms):
            boots[i].append(agg(m, wts))
    out = {}
    for i, name in enumerate(names):
        r = dict(pts[i])
        if i > 0:
            for k in ('brier', 'logloss', 'ece'):
                d = np.array([boots[i][b][k] - boots[0][b][k] for b in range(B)])
                r[f'd_{k}'] = pts[i][k] - pts[0][k]
                r[f'd_{k}_ci'] = [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]
        out[name] = r
    return out


# ─── 匯出 ────────────────────────────────────────────────────────────────────

def to_json(version, objective, features, offset, init, trees, meta):
    def r(x):
        return float(f'{x:.6g}')
    return {
        'version': version, 'kind': 'gbdt', 'objective': objective, 'features': list(features), 'offset': offset, 'init': r(init),
        'trees': [{'f': t['f'], 't': [r(x) for x in t['t']], 'l': t['l'], 'r': t['r'], 'v': [r(x) for x in t['v']]} for t in trees],
        'meta': meta,
    }


def round_json(js):
    """JSON 寫出時的數值精度與 TypeScript 讀到的一致：預測用捨入後的樹。"""
    return [{'f': t['f'], 't': t['t'], 'l': t['l'], 'r': t['r'], 'v': t['v']} for t in js['trees']], js['init']


# ─── 第 1 號 ─────────────────────────────────────────────────────────────────

PURE_DROP = ('baseLogit', 'baseXround', 'uniXbase')


def cmd_belief(a):
    cols, M = load_bin(a.data)
    ci = {c: i for i, c in enumerate(cols)}
    feat_names = cols[ci['strong'] + 1:]
    cand = [c for c in feat_names if c.startswith('p_')]
    feat_names = [c for c in feat_names if not c.startswith('p_')]
    X = M[:, ci['strong'] + 1: ci['strong'] + 1 + len(feat_names)].astype(np.float64)
    y = M[:, ci['y']].astype(np.float64)
    gi = M[:, ci['gi']].astype(np.int64)
    late = M[:, ci['late']] > 0.5
    w = np.ones(len(y))
    gid = np.zeros(len(y), dtype=np.int64)
    train = ~late & (gi % 5 != 0)
    valid = ~late & (gi % 5 == 0)
    pure = a.mode == 'pure'
    allowed = [i for i, f in enumerate(feat_names) if not (pure and f in PURE_DROP) and f not in (a.drop or [])]
    offset = -1 if pure else feat_names.index('baseLogit')
    print(f'belief {a.mode}: {train.sum()} train rows, {valid.sum()} valid rows, {late.sum()} test rows, {len(allowed)} features', file=sys.stderr)
    trees, init = boost(X, y, gid, w, train, valid, 'binary', allowed, offset, a.trees, a.depth, a.lr, a.l2, a.min_hess, a.subsample, a.seed)
    js = to_json(f'r90-belief-{a.mode}-1', 'binary', feat_names, offset, init, trees, {})
    tr, ini = round_json(js)
    z = predict(tr, ini, X, offset)
    q = sigmoid(z)
    test = late
    pb = M[:, ci['pBase']].astype(np.float64)
    pu = M[:, ci['pUni']].astype(np.float64)
    res = {}
    for name, mask in (('test', test), ('test_loyal', test & (M[:, ci['percival']] < 0.5)), ('test_percival', test & (M[:, ci['percival']] > 0.5)),
                       ('test_strong', test & (M[:, ci['strong']] > 0.5))):
        ms = [binary_metrics_by_game(pb[mask], y[mask], gi[mask]), binary_metrics_by_game(q[mask], y[mask], gi[mask]), binary_metrics_by_game(pu[mask], y[mask], gi[mask])]
        res[name] = compare(ms, ['現行查表', '第1號模型(原始)', '只用規則'], B=a.boot)
    meta = {
        'data': 'games_cache.json 十人局，忠臣／派西座位每一次非強制提議的投票點，對另外 9 人（0 < 現行 p < 1 的點）',
        'split': '照日期排序前 2/3 擬合（其中局序號 mod 5 == 0 的局決定樹的棵數），後 1/3 驗證',
        'rows': {'train': int(train.sum()), 'valid': int(valid.sum()), 'test': int(test.sum())},
        'games': {'train': int(len(np.unique(gi[~late]))), 'test': int(len(np.unique(gi[late])))},
        'hyper': {'trees': len(trees), 'depth': a.depth, 'lr': a.lr, 'l2': a.l2, 'minHess': a.min_hess, 'subsample': a.subsample, 'seed': a.seed, 'bins': NBINS},
        'mode': a.mode, 'drop': a.drop or [], 'oos': res,
    }
    js['meta'] = meta
    if a.out:
        with open(a.out, 'w', encoding='utf8') as fh:
            json.dump(js, fh, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(meta['oos'], ensure_ascii=False, indent=1))
    if a.dump:
        np.save(a.dump, np.stack([gi[test], y[test], pb[test], q[test]], axis=1))


# ─── 第 2 號 ─────────────────────────────────────────────────────────────────

def load_assassin(paths, domain, late_override=None):
    rows = []
    for p in paths:
        with open(p, encoding='utf8') as fh:
            for line in fh:
                if line.strip():
                    d = json.loads(line)
                    d['domain'] = domain
                    if late_override is not None:
                        d['late'] = late_override
                    rows.append(d)
    return rows


def assassin_matrix(spots):
    X, y, gid, front, wl = [], [], [], [], []
    for si, s in enumerate(spots):
        for c in s['cands']:
            X.append(c['x'])
            y.append(1.0 if c['seat'] == s['merlin'] else 0.0)
            gid.append(si)
            front.append(c['front'])
            wl.append(c['wl'] if c['wl'] is not None else c['x'][0])
    return np.array(X, dtype=np.float64), np.array(y), np.array(gid, dtype=np.int64), np.array(front), np.array(wl, dtype=np.float64)


def spot_scores(z, y, gid, front, spots, sel_spots, tier):
    """每一個選到的刺殺點：模型第一名（tier = 只在分層第一層裡挑）是不是梅林、梅林的 −log P（全部候選人 softmax）、6 人的 Brier。"""
    hit, ll, br = [], [], []
    for si in sel_spots:
        idx = np.where(gid == si)[0]
        zz = z[idx]
        p = np.exp(zz - zz.max())
        p /= p.sum()
        yy = y[idx]
        cand = idx if not tier or front[idx].max() == 0 else idx[front[idx] > 0]
        best = cand[int(np.argmax(z[cand]))]
        hit.append(float(y[best] == 1))
        ll.append(-math.log(max(float((p * yy).sum()), 1e-12)))
        br.append(float(((p - yy) ** 2).sum()))
    return np.array(hit), np.array(ll), np.array(br)


def paired(a, b, B, seed=90):
    """b − a 的平均與 95% 重抽信賴區間（同一批刺殺點配對）。"""
    rng = np.random.default_rng(seed)
    n = len(a)
    d = b - a
    bs = [d[rng.integers(0, n, n)].mean() for _ in range(B)]
    return float(d.mean()), [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))]


def cmd_assassin(a):
    feat_names = json.load(open(a.human[0][:-6] + '.meta.json', encoding='utf8'))['features']
    hum = load_assassin(a.human, 'human')
    bots = [load_assassin([p], f'bot{i}', late_override=0) for i, p in enumerate(a.bot)]
    spots = hum + [s for b in bots for s in b]
    X, y, gid, front, wl = assassin_matrix(spots)
    dom = np.array([spots[g]['domain'] for g in gid])
    sdom = np.array([s['domain'] for s in spots])
    slate = np.array([s.get('late', 0) for s in spots])
    sgi = np.array([s['gi'] for s in spots])
    off = feat_names.index(a.offset) if a.offset else -1
    w = np.where(dom == 'human', a.human_weight, 1.0)
    allowed = [i for i, f in enumerate(feat_names) if f not in (a.drop or [])]
    h_test = np.where((sdom == 'human') & (slate == 1))[0]
    h_valid_spot = (sdom == 'human') & (slate == 0) & (sgi % 5 == 0)
    h_train_spot = (sdom == 'human') & (slate == 0) & ~h_valid_spot
    # --valid-bot：機器人局序號 mod 5 == 0 的刺殺點也拿來決定樹的棵數（不進擬合）；正式模型照常用全部機器人局擬合以外的點。
    b_valid_spot = (sdom != 'human') & (sgi % 5 == 0) if a.valid_bot else np.zeros(len(spots), dtype=bool)
    rowmask = lambda smask: smask[gid]  # noqa: E731

    def fit(train_spots, tag, valid_spots=None):
        vs = h_valid_spot | (b_valid_spot & train_spots) if valid_spots is None else valid_spots
        trees, init = boost(X, y, gid, w, rowmask(train_spots & ~b_valid_spot), rowmask(vs), 'group', allowed, off, a.trees, a.depth, a.lr, a.l2,
                            a.min_hess, a.subsample, a.seed, log=False)
        js = to_json(f'r90-assassin-{tag}', 'group', feat_names, off, init, trees, {})
        tr, ini = round_json(js)
        return js, predict(tr, ini, X, off)

    allbot = np.zeros(len(spots), dtype=bool)
    for i in range(len(bots)):
        allbot |= sdom == f'bot{i}'
    js_full, zf = fit(h_train_spot | allbot, 'full')
    js_h, zh = fit(h_train_spot, 'humanOnly')
    zcf = np.zeros(len(y))
    for i in range(len(bots)):
        others = allbot & (sdom != f'bot{i}')
        jcf, z = fit(h_train_spot | others, f'cf{i}')
        m = dom == f'bot{i}'
        zcf[m] = z[m]
        if a.out_cf_models:
            jcf['meta'] = {'crossFit': f'真人局擬合那一半＋機器人局（留下 {a.bot[i].split("/")[-1]}）'}
            with open(f'{a.out_cf_models}{i}.json', 'w', encoding='utf8') as fh:
                json.dump(jcf, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'  trees: full {len(js_full["trees"])}, humanOnly {len(js_h["trees"])}', file=sys.stderr)
    results = {}

    def block(sel, zs, label):
        cur = np.array([float(spots[si]['cur'] == spots[si]['merlin']) for si in sel])
        hum_hit = np.array([float(spots[si]['human'] == spots[si]['merlin']) for si in sel])
        _, wl_ll, wl_br = spot_scores(wl, y, gid, front, spots, sel, True)
        out = {'spots': int(len(sel)), '現行刺客命中': float(cur.mean()), '真人刺客命中（紀錄）': float(hum_hit.mean()),
               '世界線 logloss': float(wl_ll.mean()), '世界線 Brier': float(wl_br.mean())}
        for name, z in zs:
            for tier in (True, False):
                hit, ll, br = spot_scores(z, y, gid, front, spots, sel, tier)
                d, ci = paired(cur, hit, a.boot)
                key = f'{name}（{"分層" if tier else "不分層"}）'
                out[key] = {'命中': float(hit.mean()), '命中差': d, '命中差 CI': ci}
                if tier:
                    dl, cil = paired(wl_ll, ll, a.boot)
                    db, cib = paired(wl_br, br, a.boot)
                    out[key].update({'logloss': float(ll.mean()), 'logloss差': dl, 'logloss差 CI': cil, 'Brier': float(br.mean()), 'Brier差': db, 'Brier差 CI': cib})
        results[label] = out

    block(h_test, [('第2號（真人＋機器人）', zf), ('第2號（只用真人）', zh)], '真人局驗證（後 1/3）')
    for i in range(len(bots)):
        sel = np.where(sdom == f'bot{i}')[0]
        block(sel, [('第2號（交叉擬合）', zcf)], f'機器人 {a.bot[i].split("/")[-1]}（交叉擬合：留這一組）')
    meta = {
        'data': '刺殺點（三藍之後；真人局 games_cache.json 十人局＋自我對打 detail=1 的整局紀錄），每個候選人（非紅、非刺客）一列；y = 是梅林',
        'split': '真人局照日期排序前 2/3 擬合（局序號 mod 5 == 0 的局決定樹的棵數）、後 1/3 驗證；機器人局全部進擬合（交叉擬合時留下要量的那一組）',
        'bots': [p.split('/')[-1] for p in a.bot], 'humanWeight': a.human_weight, 'validBot': bool(a.valid_bot), 'offset': a.offset or None, 'drop': a.drop or [],
        'hyper': {'trees': len(js_full['trees']), 'depth': a.depth, 'lr': a.lr, 'l2': a.l2, 'minHess': a.min_hess, 'subsample': a.subsample, 'seed': a.seed},
        'oos': results,
    }
    js_full['meta'] = meta
    if a.out:
        with open(a.out, 'w', encoding='utf8') as fh:
            json.dump(js_full, fh, ensure_ascii=False, separators=(',', ':'))
    if a.out_human:
        js_h['meta'] = dict(meta, data=meta['data'] + '（只用真人局擬合那一半，不加機器人局）', hyper=dict(meta['hyper'], trees=len(js_h['trees'])))
        with open(a.out_human, 'w', encoding='utf8') as fh:
            json.dump(js_h, fh, ensure_ascii=False, separators=(',', ':'))
    if a.out_cf:
        np.save(a.out_cf, np.stack([gid, y, zcf, zf], axis=1))
    print(json.dumps(results, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd')
    for name in ('belief', 'assassin'):
        p = sp.add_parser(name)
        p.add_argument('--out')
        p.add_argument('--trees', type=int, default=400)
        p.add_argument('--depth', type=int, default=3)
        p.add_argument('--lr', type=float, default=0.05)
        p.add_argument('--l2', type=float, default=10.0)
        p.add_argument('--min-hess', type=float, default=50.0)
        p.add_argument('--subsample', type=float, default=0.3)
        p.add_argument('--seed', type=int, default=90)
        p.add_argument('--boot', type=int, default=500)
    pb = sp.choices['belief']
    pb.add_argument('--data', nargs='+', required=True)
    pb.add_argument('--mode', default='stack', choices=('stack', 'pure'))
    pb.add_argument('--dump')
    pb.add_argument('--drop', nargs='*', help='這些特徵不拿來切（例如座位）')
    pa = sp.choices['assassin']
    pa.add_argument('--human', nargs='+', required=True)
    pa.add_argument('--bot', nargs='*', default=[])
    pa.add_argument('--offset', default='')
    pa.add_argument('--drop', nargs='*')
    pa.add_argument('--valid-bot', action='store_true')
    pa.add_argument('--human-weight', type=float, default=1.0)
    pa.add_argument('--out-cf')
    pa.add_argument('--out-human')
    pa.add_argument('--out-cf-models')
    a = ap.parse_args()
    if a.cmd == 'belief':
        return cmd_belief(a)
    if a.cmd == 'assassin':
        return cmd_assassin(a)
    ap.print_help()


if __name__ == '__main__':
    main()
