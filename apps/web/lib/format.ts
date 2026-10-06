/** Formatting that never invents a number: missing values render as NO DATA. */
export const NO_DATA = 'NO DATA';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function toNum(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function usd(v: unknown, opts: { signed?: boolean; digits?: number } = {}): string {
  const n = toNum(v);
  if (n === null) return NO_DATA;
  const digits = opts.digits ?? (Math.abs(n) >= 1000 ? 0 : 2);
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  return opts.signed && n > 0 ? `+${s}` : s;
}

/** `v` is a fraction (0.12 = 12 %). */
export function pct(v: unknown, opts: { signed?: boolean; digits?: number } = {}): string {
  const n = toNum(v);
  if (n === null) return NO_DATA;
  const s = `${(n * 100).toFixed(opts.digits ?? 1)} %`;
  return opts.signed && n > 0 ? `+${s}` : s;
}

export function num(v: unknown, digits = 2): string {
  const n = toNum(v);
  return n === null ? NO_DATA : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function score(v: unknown): string {
  const n = toNum(v);
  return n === null ? NO_DATA : n.toFixed(1);
}

export function dateTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function ago(v: string | number | Date | null | undefined, now = Date.now()): string {
  if (v === null || v === undefined) return '—';
  const ms = now - new Date(v).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 0) return 'in the future';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function days(v: unknown): string {
  const n = toNum(v);
  return n === null ? NO_DATA : n < 1 ? '< 1 day' : `${Math.round(n)} days`;
}

const WORDS: Record<string, string> = { ai: 'AI', saas: 'SaaS', b2b: 'B2B', api: 'API', llm: 'LLM', pm: 'PM', ev: 'EV', tos: 'ToS', usd: 'USD', oos: 'OOS', dsr: 'DSR', e: 'E' };

/** SNAKE_CASE enum → readable label ("AI_SAAS" → "AI SaaS", "E_COMMERCE" → "E-commerce"). */
export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  const words = s
    .toLowerCase()
    .split('_')
    .map((w, i) => WORDS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return words.join(' ').replace(/^E commerce/, 'E-commerce');
}

export function pnlClass(v: unknown): string {
  const n = toNum(v);
  if (n === null || n === 0) return 'text-muted';
  return n > 0 ? 'text-positive' : 'text-negative';
}
