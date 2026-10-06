import Link from 'next/link';
import { CATEGORIES, KINDS, RISK_LEVELS, STATUSES } from '@/lib/constants';
import { humanize } from '@/lib/format';

export interface FilterValues {
  search?: string;
  category?: string;
  status?: string;
  kind?: string;
  riskLevel?: string;
  minScore?: string;
  maxScore?: string;
  minProfit?: string;
  maxCapital?: string;
  minAutomation?: string;
  minScalability?: string;
  sinceDays?: string;
  sort?: string;
  dir?: string;
  includeArchived?: string;
}

/** Plain GET form: filters live in the URL, work without JavaScript and can be bookmarked. */
export function ExperimentFilters({ values, action }: { values: FilterValues; action: string }) {
  const input = 'w-full';
  return (
    <form method="get" action={action} className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-3 md:grid-cols-4 xl:grid-cols-8">
      <label className="col-span-2 flex flex-col gap-1 text-[11px] text-muted">
        Search
        <input name="search" defaultValue={values.search} placeholder="name, description, module" className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Category
        <select name="category" defaultValue={values.category ?? ''} className={input}>
          <option value="">All</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Status
        <select name="status" defaultValue={values.status ?? ''} className={input}>
          <option value="">All (not archived)</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Kind
        <select name="kind" defaultValue={values.kind ?? ''} className={input}>
          <option value="">All</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Risk
        <select name="riskLevel" defaultValue={values.riskLevel ?? ''} className={input}>
          <option value="">All</option>
          {RISK_LEVELS.map((r) => (
            <option key={r} value={r}>
              {humanize(r)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Score from
        <input name="minScore" type="number" min={0} max={100} defaultValue={values.minScore} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Score to
        <input name="maxScore" type="number" min={0} max={100} defaultValue={values.maxScore} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted" title="Paper/simulated P&L in USD">
        Min. paper profit
        <input name="minProfit" type="number" defaultValue={values.minProfit} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Max. capital req.
        <input name="maxCapital" type="number" min={0} defaultValue={values.maxCapital} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Min. automation
        <input name="minAutomation" type="number" min={0} max={100} defaultValue={values.minAutomation} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Min. scalability
        <input name="minScalability" type="number" min={0} max={100} defaultValue={values.minScalability} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Active within
        <select name="sinceDays" defaultValue={values.sinceDays ?? ''} className={input}>
          <option value="">Any time</option>
          <option value="1">24 hours</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Sort
        <select name="sort" defaultValue={values.sort ?? 'rank'} className={input}>
          <option value="rank">Rank</option>
          <option value="score">Score</option>
          <option value="pnl">Paper profit</option>
          <option value="activity">Last activity</option>
          <option value="created">Created</option>
          <option value="name">Name</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Direction
        <select name="dir" defaultValue={values.dir ?? 'desc'} className={input}>
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
      <label className="flex items-end gap-2 pb-1.5 text-[11px] text-muted">
        <input type="checkbox" name="includeArchived" value="true" defaultChecked={values.includeArchived === 'true'} /> Archived
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white">
          Apply
        </button>
        <Link href={action} className="px-1 py-1.5 text-[13px] text-muted hover:text-text">
          Reset
        </Link>
      </div>
    </form>
  );
}

const KEYS: (keyof FilterValues)[] = ['search', 'category', 'status', 'kind', 'riskLevel', 'minScore', 'maxScore', 'minProfit', 'maxCapital', 'minAutomation', 'minScalability', 'sinceDays', 'sort', 'dir', 'includeArchived'];

export function readFilters(sp: Record<string, string | string[] | undefined>): FilterValues {
  const out: FilterValues = {};
  for (const k of KEYS) {
    const v = sp[k];
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s) out[k] = s;
  }
  return out;
}
