/**
 * 局勢樹的網站純函式（web components/analysis/stateTree/stateTree.ts；Edward 2026-10-31）與任務順序篩選子句
 * （@avalon/shared missionSeq）。虛構的局（名字是 datasetBuilder 的虛構名字）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFilter, decodeGamesDataset, missionSequence, sanitizeFilter, type Game, type GameFilter, type VotingProposal,
} from '@avalon/shared/stats';
import {
  buildStateTree, defaultExpanded, foldSmall, hitRate, lakeKey, lakeKeyLabel, mergeNodeClauses, nextRoundFacts, nodeClauses,
  outcomeRate, stateTreeFindings, toStateGame, toStateGames, divergingColor, metricRate, NO_DATA_COLOR, type StateGame, type StateNode,
} from '../../../web/src/components/analysis/stateTree/stateTree';
import { allExpandable, ancestry, findNode, layoutTree, visibleDepth } from '../../../web/src/components/analysis/stateTree/layout';
import {
  branchLabel, branchOfNode, recordLakeObs, recordMatchesBranch, recordSequence, sanitizeBranch,
} from '../../../web/src/components/analysis/stateTree/recordBranch';
import {
  EMPTY_RECORDS_FILTER, matchesRecords, parseRecordsFilter, recordsFilterActive, type RecordGame, type RecordPost,
} from '../../../web/src/utils/records';
import { makeDataset, type GameSpec } from './stats/datasetBuilder';

// 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅），5 派西維爾、6 梅林、7..0 忠臣（藍）
const CELLS: Record<string, string[]> = {
  藍: ['ooo', 'oooo', 'oooo', 'ooooo', 'ooooo'],
  紅: ['oox', 'ooox', 'ooox', 'oooxx', 'oooox'],
};

/** 依任務順序組出每個任務的出牌（第 4 個任務的紅要兩張失敗）。 */
function missionsOf(seq: string): string {
  const cells = [...seq].map((c, i) => CELLS[c][i]);
  while (cells.length < 5) cells.push('');
  return cells.join('|');
}

function spec(seq: string, outcome: string, extra: Partial<GameSpec> = {}): GameSpec {
  return { missions: missionsOf(seq), outcome, lakes: '------', claims: '', ...extra };
}

function decode(specs: GameSpec[]): Game[] {
  return decodeGamesDataset(makeDataset(specs)).games;
}

function stateGames(specs: GameSpec[]): StateGame[] {
  return toStateGames(decode(specs)).games;
}

function find(node: StateNode, id: string): StateNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
}

describe('任務順序（10 人局，依出牌）', () => {
  it('reads blue / red per mission, the fourth needs two fails, stops once decided', () => {
    const [g1, g2, g3] = decode([
      spec('藍紅藍藍', '三藍活'),
      { missions: 'ooo|oooo|oooo|ooox|ooooo', outcome: '三藍活' }, // 第 4 個任務一張失敗仍是藍 → 藍藍藍
      { missions: 'oo|oooo|oooo||', outcome: '三藍活' }, // 第 1 個任務兩人 → 不是 10 人局
    ]);
    expect(missionSequence(g1)).toBe('藍紅藍藍');
    expect(missionSequence(g2)).toBe('藍藍藍');
    expect(missionSequence(g3)).toBeNull();
  });

  it('missionSeq clause matches the prefix and is sanitized', () => {
    const decoded = decodeGamesDataset(makeDataset([spec('藍紅藍藍', '三藍活'), spec('紅藍藍藍', '三藍死'), spec('藍紅紅紅', '三紅')]));
    const ids = (f: GameFilter): number[] => applyFilter(decoded, { asOf: '2026-10-31' }, f).games.map((g) => g.seq);
    expect(ids({ v: 1, clauses: [{ kind: 'missionSeq', prefix: '藍紅' }] })).toEqual([0, 2]);
    expect(ids({ v: 1, clauses: [{ kind: 'missionSeq', prefix: '藍紅', not: true }] })).toEqual([1]);
    const bad = sanitizeFilter({ v: 1, clauses: [{ kind: 'missionSeq', prefix: '藍x' } as never, { kind: 'missionSeq', prefix: '紅紅紅' }] });
    expect(bad.filter.clauses).toEqual([{ kind: 'missionSeq', prefix: '紅紅紅' }]);
    expect(bad.warnings.length).toBe(1);
  });
});

describe('一局 → 樹要的欄位', () => {
  it('keeps lakes (claim, holder / target camp) and per-round teams; drops inconsistent games', () => {
    const votes: VotingProposal[] = [
      [1, 1, '157', '1578'], [1, 2, '267', '12345678'], [2, 1, '2670', '12345678'], [3, 1, '26780', ''], [3, 2, '2670', '12345678'],
    ];
    const [a] = decode([spec('藍藍紅藍', '三藍活', { lakes: '711762', claims: '71o17x62x', votes })]);
    expect(toStateGame(a)).toEqual({
      seq: '藍藍紅藍',
      outcome: '三藍活',
      lakes: [{ claim: 'o', holder: 'B', target: 'R' }, { claim: 'x', holder: 'R', target: 'B' }, { claim: 'x', holder: 'B', target: 'R' }],
      teams: [{ team: '267', first: '157', tries: 2 }, { team: '2670', first: '2670', tries: 1 }, { team: '2670', first: '26780', tries: 2 }, null, null],
    });
    const res = toStateGames(decode([
      spec('藍紅藍藍', '三紅'), // 三紅但三藍 → 不列入
      spec('藍紅', '三藍活'), // 沒打完
      spec('紅紅紅', ''), // 沒有結果
      spec('紅紅紅', '三紅'),
    ]));
    expect(res.games.map((g) => g.seq)).toEqual(['紅紅紅']);
    expect(res.excluded).toBe(3);
  });

  it('lake keys per mode and their labels', () => {
    const lie = { claim: 'o' as const, holder: 'R' as const, target: 'R' as const };
    expect(['claim', 'truth', 'holder', 'none'].map((m) => lakeKey(lie, m as never))).toEqual(['o', 'o!', 'Ro', '-']);
    expect(lakeKey({ claim: '', holder: 'B', target: 'B' }, 'claim')).toBe('-');
    expect(lakeKey(null, 'truth')).toBe('-');
    expect(lakeKey({ claim: 'x', holder: '', target: '' }, 'truth')).toBe('?');
    expect(['o', 'x', '-', '?', 'o!', 'x+', 'Bo', 'Rx'].map(lakeKeyLabel))
      .toEqual(['說好', '說壞', '未記錄', '陣營不明', '說好・不實', '說壞・屬實', '藍持湖說好', '紅持湖說壞']);
  });
});

describe('樹', () => {
  const specs: GameSpec[] = [
    spec('藍藍藍', '三藍活', { lakes: '71----', claims: '71o' }),
    spec('藍藍藍', '三藍死', { lakes: '71----', claims: '71o' }),
    spec('藍藍紅藍', '三藍活', { lakes: '7162--', claims: '71x62o' }),
    spec('藍紅紅紅', '三紅', { lakes: '1726--', claims: '17o26x' }),
    spec('紅藍紅藍紅', '三紅', { lakes: '------' }),
    spec('紅紅紅', '三紅', { lakes: '81----', claims: '81x' }),
  ];
  const games = stateGames(specs);

  it('mission-only tree: counts, outcomes, decided leaves', () => {
    const root = buildStateTree(games, 'none');
    expect(root.n).toBe(6);
    expect(root.children.map((c) => [c.id, c.n])).toEqual([['藍', 4], ['紅', 2]]);
    const bb = find(root, '藍藍') as StateNode;
    expect(bb.outcomes).toEqual({ 三紅: 0, 三藍死: 1, 三藍活: 2 });
    expect(find(root, '藍藍藍')?.decided).toBe('三藍');
    expect(find(root, '藍藍藍')?.children).toEqual([]);
    expect(find(root, '紅藍紅藍紅')?.decided).toBe('三紅');
    expect(outcomeRate(bb.outcomes, '三藍活')).toBeCloseTo(2 / 3);
    expect(hitRate(bb.outcomes)).toBeCloseTo(1 / 3);
    expect(hitRate(find(root, '紅紅紅')!.outcomes)).toBeNull();
  });

  it('lake layers after missions 2, 3, 4 when the game goes on', () => {
    const root = buildStateTree(games, 'claim');
    const bb = find(root, '藍藍') as StateNode;
    expect(bb.children.map((c) => [c.label, c.n])).toEqual([['湖1 說好', 2], ['湖1 說壞', 1]]);
    // 第 3 個任務打完 3 藍 → 沒有第 2 次湖
    expect(find(root, '藍藍~o藍')?.children).toEqual([]);
    // 藍藍~x紅 → 湖2 說好 → 藍
    expect(find(root, '藍藍~x紅~o藍')?.decided).toBe('三藍');
    // 紅藍：湖1 沒記錄
    expect(find(root, '紅藍')?.children.map((c) => c.id)).toEqual(['紅藍~-']);
    // 紅紅紅：第 3 個任務前有一層湖
    expect(find(root, '紅紅~x紅')?.n).toBe(1);
    const truth = buildStateTree(games, 'truth');
    // 71o：7 忠臣湖 1 刺客 → 說好不實；71x → 說壞屬實
    expect(find(truth, '藍藍')?.children.map((c) => c.id)).toEqual(['藍藍~o!', '藍藍~x+']);
    const holder = buildStateTree(games, 'holder');
    expect(find(holder, '藍紅')?.children.map((c) => c.id)).toEqual(['藍紅~Ro']);
  });

  it('folds small branches into 其他 and expands up to a round by default', () => {
    const folded = foldSmall(buildStateTree(games, 'none'), 2);
    const red = find(folded, '紅') as StateNode;
    expect(red.children.map((c) => [c.kind, c.n, c.folded])).toEqual([['other', 2, 2]]);
    expect(red.children[0].outcomes.三紅).toBe(2);
    const open = defaultExpanded(buildStateTree(games, 'claim'), 2);
    expect(open.has('root')).toBe(true);
    expect(open.has('藍')).toBe(true);
    expect(open.has('藍藍')).toBe(true); // 後面是第 1 次湖
    expect(open.has('藍藍~o')).toBe(false);
    expect(defaultExpanded(buildStateTree(games, 'none'), 2).has('藍藍')).toBe(false);
  });

  it('node → filter clauses, merged into an existing filter', () => {
    const root = buildStateTree(games, 'truth');
    const node = find(root, '藍藍~x+紅') as StateNode;
    expect(nodeClauses(node)).toEqual([
      { kind: 'missionSeq', prefix: '藍藍紅' },
      { kind: 'lake', index: 1, targetSide: 'red', claim: ['red'] },
    ]);
    expect(nodeClauses(find(buildStateTree(games, 'claim'), '紅藍~-') as StateNode)).toEqual([
      { kind: 'missionSeq', prefix: '紅藍' },
      { kind: 'lake', index: 1, claim: ['red', 'blue'], not: true },
    ]);
    expect(nodeClauses(find(buildStateTree(games, 'holder'), '藍紅~Ro') as StateNode)?.[1])
      .toEqual({ kind: 'lake', index: 1, holderSide: 'red', claim: ['blue'] });
    expect(nodeClauses({ kind: 'other', seq: '藍', path: [] })).toBeNull();
    expect(nodeClauses(root)).toEqual([]);
    const merged = mergeNodeClauses([
      { kind: 'category', in: ['線瓦'] }, { kind: 'missionSeq', prefix: '紅' }, { kind: 'lake', index: 1, claim: ['blue'] },
      { kind: 'lake', index: 2, holderSide: 'red' },
    ], node);
    expect(merged).toEqual([
      { kind: 'category', in: ['線瓦'] }, { kind: 'lake', index: 2, holderSide: 'red' },
      { kind: 'missionSeq', prefix: '藍藍紅' }, { kind: 'lake', index: 1, targetSide: 'red', claim: ['red'] },
    ]);
  });

  it('the clauses select exactly the node’s games', () => {
    const decoded = decodeGamesDataset(makeDataset(specs));
    const ctx = { asOf: '2026-10-31' };
    for (const mode of ['claim', 'truth', 'holder'] as const) {
      const walk = (n: StateNode): void => {
        const clauses = nodeClauses(n);
        if (clauses) expect(applyFilter(decoded, ctx, { v: 1, clauses }).games.length).toBe(n.n);
        n.children.forEach(walk);
      };
      walk(buildStateTree(games, mode));
    }
  });
});

describe('下一個任務的派隊', () => {
  const t = (team: string, first = team, tries = 1): { team: string; first: string; tries: number } => ({ team, first, tries });
  const g = (seq: string, teams: StateGame['teams']): StateGame => ({ seq, outcome: '三藍活', lakes: [null, null, null], teams });

  it('re-proposing the last mission team (照派), first-proposal pass, tries, next blue', () => {
    const games = [
      g('藍藍藍', [t('123'), t('1234'), t('12345', '12345', 1), null, null]),
      g('藍藍紅藍', [t('123'), t('1234'), t('56789', '12340', 3), t('12345'), null]),
      g('藍藍紅藍', [t('123'), t('1234'), t('56780', '56780', 2), t('12345'), null]),
      g('藍藍', [t('123'), t('1234'), null, null, null]), // 沒有第 3 個任務：不算
    ];
    const f = nextRoundFacts(games, 2);
    expect(f?.round).toBe(3);
    expect(f?.reuse).toEqual({ yes: 2, of: 3 });
    expect(f?.reuseBlue).toEqual({ yes: 1, of: 2 });
    expect(f?.otherBlue).toEqual({ yes: 0, of: 1 });
    expect(f?.firstPass).toEqual({ yes: 1, of: 3 });
    expect(f?.tries).toEqual({ sum: 6, of: 3 });
    expect(f?.nextBlue).toEqual({ yes: 1, of: 3 });
    expect(nextRoundFacts(games, 0)?.reuse).toEqual({ yes: 0, of: 0 });
    expect(nextRoundFacts([games[0]], 3)).toBeNull();
  });
});

describe('看得出什麼', () => {
  it('same-score contrasts, lake after mission 2, reuse after a blue mission 2', () => {
    const many = (seq: string, outcome: string, count: number, extra: Partial<GameSpec> = {}): GameSpec[] =>
      Array.from({ length: count }, () => spec(seq, outcome, extra));
    const games = stateGames([
      ...many('藍紅藍紅藍', '三藍活', 3, { lakes: '71----', claims: '71o' }),
      ...many('藍紅藍紅紅', '三紅', 1, { lakes: '71----', claims: '71o' }),
      ...many('紅藍紅藍紅', '三紅', 3, { lakes: '71----', claims: '71x' }),
      ...many('紅藍紅藍藍', '三藍死', 1, { lakes: '71----', claims: '71x' }),
    ]);
    const f = stateTreeFindings(games, 2);
    expect(f.total).toBe(8);
    expect(f.baseline.blueWin).toBeCloseTo(3 / 8);
    // 1:1、2:2 都有對照；差最多的是 75% vs 0%
    expect(f.contrasts[0].gap).toBeCloseTo(0.75);
    expect(f.contrasts.map((c) => c.score)).toContain('2:2');
    const c22 = f.contrasts.find((c) => c.score === '2:2');
    expect([c22?.high.seq, c22?.low.seq, c22?.high.n, c22?.low.n]).toEqual(['藍紅藍紅', '紅藍紅藍', 4, 4]);
    expect(f.lakeAfterR2.pooled?.good.blueWin).toBeCloseTo(0.75);
    expect(f.lakeAfterR2.pooled?.bad.blueWin).toBe(0);
    expect(f.lakeAfterR2.bySeq).toEqual([]); // 同一個順序裡沒有說好和說壞都夠的
    expect(f.lakeAfterR2.withinGap).toBeNull();
    // 同一個前兩局裡說好／說壞都有：差距與說壞比例
    const mixed = stateTreeFindings(stateGames([
      ...many('藍藍藍', '三藍活', 2, { lakes: '71----', claims: '71o' }),
      ...many('藍藍紅紅紅', '三紅', 2, { lakes: '71----', claims: '71x' }),
    ]), 2);
    expect(mixed.lakeAfterR2.bySeq.map((x) => [x.seq, x.gap, x.badShare])).toEqual([['藍藍', 1, 0.5]]);
    expect(mixed.lakeAfterR2.withinGap).toBe(1);
    expect(f.reuseAfterR2Blue?.nextBlue).toEqual({ yes: 0, of: 4 }); // 紅藍 → 第 3 個任務都是紅
    expect(stateTreeFindings([], 2).reuseAfterR2Blue).toBeNull();
  });
});

describe('節點顏色', () => {
  it('diverges from the overall rate: grey at the midpoint, blue / red at the poles', () => {
    expect(divergingColor(0.3, 0.3, 'blueWin')).toBe('#52525b');
    expect(divergingColor(1, 0.3, 'blueWin')).toBe('#2563eb');
    expect(divergingColor(0, 0.3, 'blueWin')).toBe('#dc2626');
    expect(divergingColor(1, 0.5, 'threeRed')).toBe('#dc2626');
    expect(divergingColor(0, 0.5, 'threeRed')).toBe('#2563eb');
    expect(divergingColor(null, 0.5, 'blueWin')).toBe(NO_DATA_COLOR);
    expect(metricRate({ 三紅: 1, 三藍死: 1, 三藍活: 2 }, 'blueWin')).toBe(0.5);
    expect(metricRate({ 三紅: 1, 三藍死: 1, 三藍活: 2 }, 'threeRed')).toBe(0.25);
  });
});

describe('桌機版位置', () => {
  it('leaves stack top-down, parents sit between their first and last visible child', () => {
    const games = stateGames([spec('藍藍藍', '三藍活'), spec('藍紅紅紅', '三紅'), spec('紅紅紅', '三紅')]);
    const root = buildStateTree(games, 'none');
    const opt = { colWidth: 100, rowHeight: 40, boxWidth: 80, boxHeight: 30 };
    const layout = layoutTree(root, new Set(['root', '藍']), opt);
    const at = (id: string): [number, number] | undefined => {
      const p = layout.nodes.find((x) => x.node.id === id);
      return p ? [p.x, p.y] : undefined;
    };
    expect(at('藍藍')).toEqual([200, 0]);
    expect(at('藍紅')).toEqual([200, 40]);
    expect(at('藍')).toEqual([100, 20]);
    expect(at('紅')).toEqual([100, 80]);
    expect(at('root')).toEqual([0, 50]);
    expect(at('藍藍藍')).toBeUndefined();
    expect(layout.nodes.find((x) => x.node.id === '紅')?.collapsed).toBe(true);
    expect([layout.width, layout.height, layout.maxDepth]).toEqual([280, 110, 2]);
    expect(visibleDepth(root, allExpandable(root))).toBe(4);
    expect(findNode(root, '藍紅紅')?.n).toBe(1);
    expect(ancestry(root, '藍紅紅').map((n) => n.id)).toEqual(['root', '藍', '藍紅', '藍紅紅']);
  });
});

describe('牌譜紀錄的局勢樹分支', () => {
  // 配置 936758：9 刺客、3 莫甘娜、6 莫德雷德、7 奧伯倫（紅），5 派西維爾、8 梅林，其餘忠臣
  const game: RecordGame = {
    config: '936758',
    names: 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`),
    rounds: [
      { proposals: [{ team: '147', votes: [] }], mission: 'ooo' },
      { proposals: [{ team: '5680', votes: [] }], mission: 'ooox' },
      { proposals: [{ team: '1458', votes: [] }], mission: 'oooo' },
      { proposals: [{ team: '15678', votes: [] }], mission: 'oooox' }, // 一張失敗：第 4 輪仍是藍
    ],
    lakes: [{ after: 2, holder: '0', target: '9', claim: 'x' }, { after: 3, holder: '9', target: '1', claim: '?' }],
    assassination: '8',
    outcome: '三藍死',
    category: '線瓦',
  };
  const post: RecordPost = { id: '1432000000000000001', title: '虛構', tags: [], created: '2026-10-25T23:00:00+08:00', date: '2026-10-25', game };

  it('sequence, lake observations and branch matching follow the tree’s rules', () => {
    expect(recordSequence(game)).toBe('藍紅藍藍');
    expect(recordLakeObs(game, 2)).toEqual({ claim: 'x', holder: 'B', target: 'R' });
    expect(recordLakeObs(game, 3)).toEqual({ claim: '', holder: 'R', target: 'B' });
    expect(recordLakeObs(game, 4)).toBeNull();
    expect(recordMatchesBranch(game, { seq: '藍紅', lakes: [{ after: 2, key: 'x' }] })).toBe(true);
    expect(recordMatchesBranch(game, { seq: '藍紅藍', lakes: [{ after: 2, key: 'x+' }, { after: 3, key: '-' }] })).toBe(true);
    expect(recordMatchesBranch(game, { seq: '藍紅', lakes: [{ after: 2, key: 'Bx' }] })).toBe(true);
    expect(recordMatchesBranch(game, { seq: '藍紅', lakes: [{ after: 2, key: 'o' }] })).toBe(false);
    expect(recordMatchesBranch(game, { seq: '紅', lakes: [] })).toBe(false);
    expect(recordMatchesBranch(null, { seq: '藍', lakes: [] })).toBe(false);
  });

  it('tree node → branch; label; stored branch is sanitized; records filter uses it', () => {
    const games = stateGames([spec('藍紅藍藍', '三藍死', { lakes: '01----', claims: '01x' })]);
    const node = find(buildStateTree(games, 'truth'), '藍紅~x+藍') as StateNode;
    const branch = branchOfNode(node);
    expect(branch).toEqual({ seq: '藍紅藍', lakes: [{ after: 2, key: 'x+' }] });
    expect(branchLabel(branch!)).toBe('藍紅 → 湖1 說壞・屬實 → 藍紅藍');
    expect(branchLabel({ seq: '紅', lakes: [] })).toBe('紅');
    expect(branchOfNode({ kind: 'other', seq: '藍', path: [] })).toBeNull();
    expect(branchOfNode({ kind: 'lake', seq: '藍紅', path: [{ kind: 'lake', key: '?', index: 1 }] })).toBeNull();
    expect(sanitizeBranch({ seq: '藍紅', lakes: [{ after: 2, key: 'x+' }] })).toEqual({ seq: '藍紅', lakes: [{ after: 2, key: 'x+' }] });
    expect(sanitizeBranch({ seq: '藍x', lakes: [] })).toBeNull();
    expect(sanitizeBranch({ seq: '藍', lakes: [{ after: 5, key: 'o' }] })).toBeNull();
    expect(sanitizeBranch({ seq: '藍', lakes: [{ after: 2, key: 'zz' }] })).toBeNull();
    const parsed = parseRecordsFilter(JSON.stringify({ result: '三藍死', branch }));
    expect(parsed.branch).toEqual(branch);
    expect(parseRecordsFilter(JSON.stringify({ branch: { seq: 1 } })).branch).toBeUndefined();
    expect(recordsFilterActive({ ...EMPTY_RECORDS_FILTER, branch: branch! })).toBe(true);
    expect(matchesRecords(post, { ...EMPTY_RECORDS_FILTER, branch: branch! })).toBe(true);
    expect(matchesRecords(post, { ...EMPTY_RECORDS_FILTER, branch: { seq: '藍藍', lakes: [] } })).toBe(false);
  });
});
