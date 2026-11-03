import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, X } from 'lucide-react';
import { MERGE_LIMITS, pooledPlayerName, type GameFilter, type MergeGroup } from '@avalon/shared/stats';
import { splitNames, withOptions } from '../../../stats/filterDraft';

/**
 * 篩選面板的「合併計算」(Edward 2026-11-03「你能夠把 場數未滿30場的人 併成同一個人嗎 或是我希望你可以增加一個功能
 * 類似把某幾個人戰績合併計算」)：
 *  - 生涯未滿 N 場的人併成一位「散客（<N場）」(options.mergeSmall)。
 *  - 自訂合併組 (options.merge)：挑幾個名字 (與包含／排除玩家同一份名單自動完成)、取一個合併後的名字。
 * 和其他條件一樣先改草稿、按「套用」才重算；分享連結也帶著。名字清單 (datalist #stats-filter-players) 由
 * 同一個面板的「包含玩家」區塊提供。
 */
export default function MergeEditor({ draft, setDraft, inputClass }: {
  draft: GameFilter; setDraft: (f: GameFilter) => void; inputClass: string;
}): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.filter.merge';
  const small = draft.options?.mergeSmall;
  const groups = draft.options?.merge ?? [];
  const [lastGames, setLastGames] = useState<number>(small?.maxGames ?? MERGE_LIMITS.defaultGames);
  const games = small?.maxGames ?? lastGames;

  const setSmall = (on: boolean, n = games): void => {
    setLastGames(n);
    setDraft(withOptions(draft, { mergeSmall: on ? { maxGames: n } : undefined }));
  };
  const setGroups = (next: MergeGroup[]): void => setDraft(withOptions(draft, { merge: next.length ? next : undefined }));
  const updateGroup = (i: number, next: MergeGroup | null): void => {
    setGroups(groups.flatMap((g, j) => (j === i ? (next ? [next] : []) : [g])));
  };

  return (
    <div className="space-y-2" data-testid="filter-merge">
      <label className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
        <input type="checkbox" checked={Boolean(small)} onChange={(e) => setSmall(e.target.checked)} data-testid="filter-merge-small" />
        {t(`${k}.smallPrefix`, { defaultValue: '生涯未滿' })}
        <GamesInput value={games} inputClass={inputClass} label={t(`${k}.smallGames`, { defaultValue: '場數門檻' })}
          onChange={(n) => setSmall(true, n)} />
        {t(`${k}.smallSuffix`, { defaultValue: '場的人併成一位「{{name}}」', name: pooledPlayerName(games) })}
      </label>
      {groups.map((g, i) => (
        <GroupRow key={i} group={g} inputClass={inputClass} onChange={(n) => updateGroup(i, n)} onRemove={() => updateGroup(i, null)} />
      ))}
      {groups.length < MERGE_LIMITS.groups && (
        <button
          type="button"
          onClick={() => setGroups([...groups, { names: [], as: '' }])}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-white hover:text-white"
          data-testid="filter-merge-add"
        >
          <Plus size={12} />
          {t(`${k}.addGroup`, { defaultValue: '新增合併組' })}
        </button>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        {t(`${k}.hint`, {
          defaultValue: '合併在所有條件之前：之後每個區塊都把這些人當成同一位玩家（條件裡打原名也會對到合併後的人）。自訂合併的人不會再被併進散客。同一局有好幾位散客時佔好幾個座位：場數與勝率逐座位算（一局兩位散客算兩場），默契每局只算一次。',
        })}
      </p>
    </div>
  );
}

/** 場數欄：打字中可以暫時是空的；合法的整數 (範圍內) 才寫回，離開欄位時回到目前的值。 */
function GamesInput({ value, inputClass, label, onChange }: {
  value: number; inputClass: string; label: string; onChange: (n: number) => void;
}): JSX.Element {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={MERGE_LIMITS.minGames}
      max={MERGE_LIMITS.maxGames}
      className={`${inputClass} w-16`}
      value={text}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= MERGE_LIMITS.minGames && n <= MERGE_LIMITS.maxGames) onChange(n);
      }}
      onBlur={() => setText(String(value))}
      data-testid="filter-merge-small-games"
    />
  );
}

function GroupRow({ group, inputClass, onChange, onRemove }: {
  group: MergeGroup; inputClass: string; onChange: (g: MergeGroup) => void; onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.filter.merge';
  const [text, setText] = useState('');
  const add = (): void => {
    const names = splitNames(text);
    if (!names.length) return;
    const next = [...new Set([...group.names, ...names])].slice(0, MERGE_LIMITS.names);
    onChange({ ...group, names: next, as: group.as || names[0].slice(0, MERGE_LIMITS.asLength) });
    setText('');
  };
  return (
    <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 p-2" data-testid="filter-merge-group">
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="inline-flex min-w-0 items-center gap-1 text-xs text-zinc-400">
          {t(`${k}.as`, { defaultValue: '合併成' })}
          <input
            className={`${inputClass} w-32`}
            value={group.as}
            maxLength={MERGE_LIMITS.asLength}
            placeholder={t(`${k}.asPlaceholder`, { defaultValue: '顯示名字' })}
            onChange={(e) => onChange({ ...group, as: e.target.value })}
            data-testid="filter-merge-as"
          />
        </label>
        <span className="flex-1" />
        <button type="button" aria-label={t('analytics.filter.remove')} title={t('analytics.filter.remove')} onClick={onRemove}
          className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {group.names.map((n) => (
          <span key={n} className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-zinc-700 bg-zinc-900 pl-2 pr-0.5 py-0.5 text-xs text-zinc-200">
            <span className="truncate">{n}</span>
            <button type="button" aria-label={t(`${k}.removeName`, { defaultValue: '移除 {{name}}', name: n })}
              onClick={() => onChange({ ...group, names: group.names.filter((x) => x !== n) })}
              className="rounded-full p-0.5 hover:bg-zinc-800">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className={`${inputClass} w-36 min-w-0`}
          list="stats-filter-players"
          value={text}
          placeholder={t(`${k}.namePlaceholder`, { defaultValue: '加入玩家名字' })}
          aria-label={t(`${k}.namePlaceholder`, { defaultValue: '加入玩家名字' })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          data-testid="filter-merge-name"
        />
        <button type="button" onClick={add} disabled={!text.trim()}
          className="inline-flex items-center gap-0.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-white hover:text-white disabled:opacity-40">
          <Plus size={12} />
          {t(`${k}.addName`, { defaultValue: '加入' })}
        </button>
      </div>
    </div>
  );
}
