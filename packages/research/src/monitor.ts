import { ExternalApiError, describeError, type MonitorCategory } from '@aoc/core';
import type { HttpClient } from '@aoc/connectors';
import { z } from 'zod';
import { licenseConcern } from './compliance';
import type { ResearchItem } from './types';

/**
 * Research monitor: searches public APIs for new projects, papers and
 * launches relevant to the platform's themes. Results are research notes
 * (with source and licence), never code to run.
 */

export const DEFAULT_TOPICS = [
  'prediction market trading bot',
  'market making open source',
  'crypto arbitrage bot',
  'funding rate arbitrage',
  'ai agent customer support',
  'ai sales agent outbound',
  'lead generation automation',
  'micro saas ai',
];

const KEYWORDS: Array<[RegExp, number]> = [
  [/prediction market|polymarket|kalshi|event contract/i, 0.3],
  [/market.?making|order ?book|limit order/i, 0.25],
  [/arbitrage|funding rate|basis trade|cash.and.carry/i, 0.25],
  [/backtest|walk.?forward|paper trad/i, 0.15],
  [/momentum|mean.?reversion|statistical arbitrage|pairs trading/i, 0.2],
  [/ai agent|llm|gpt|claude|autonomous agent/i, 0.15],
  [/lead gen|outbound|sales agent|sdr|cold email/i, 0.2],
  [/saas|subscription|mrr|automation/i, 0.1],
  [/customer support|help ?desk|appointment|booking/i, 0.15],
];

export function relevance(text: string): number {
  let score = 0;
  for (const [re, w] of KEYWORDS) if (re.test(text)) score += w;
  return Math.min(1, Math.round(score * 100) / 100);
}

export function classify(sourceType: ResearchItem['sourceType'], text: string): MonitorCategory {
  if (sourceType === 'GITHUB') return 'NEW_OPEN_SOURCE_PROJECT';
  if (sourceType === 'PAPER') return 'NEW_RESEARCH';
  if (/\bapi\b|sdk|endpoint/i.test(text)) return 'NEW_API';
  if (/launch(es|ed)? .*(market|exchange)|new market|listing/i.test(text)) return 'NEW_MARKET';
  if (/strategy|arbitrage|market.?making|momentum/i.test(text)) return 'NEW_STRATEGY';
  return 'NEW_IDEA';
}

// ──────────────────────────────────────────────────────────────── GitHub ──

const ghRepo = z.object({
  full_name: z.string(),
  html_url: z.string().url(),
  description: z.string().nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  pushed_at: z.string().nullable(),
  archived: z.boolean(),
  language: z.string().nullable(),
  topics: z.array(z.string()).optional(),
  license: z.object({ spdx_id: z.string().nullable(), name: z.string().nullable() }).nullable(),
  owner: z.object({ login: z.string() }),
});
const ghSearch = z.object({ total_count: z.number(), items: z.array(ghRepo) });

export async function searchGitHub(http: HttpClient, query: string, opts: { token?: string; since?: Date; perPage?: number } = {}): Promise<ResearchItem[]> {
  const since = (opts.since ?? new Date(Date.now() - 180 * 86_400_000)).toISOString().slice(0, 10);
  const res = await http.json('https://api.github.com/search/repositories', ghSearch, {
    source: 'github.search',
    query: { q: `${query} pushed:>${since}`, sort: 'stars', order: 'desc', per_page: opts.perPage ?? 10 },
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
  });
  return res.items.map((r) => {
    const text = `${r.full_name} ${r.description ?? ''} ${(r.topics ?? []).join(' ')}`;
    const spdx = r.license?.spdx_id ?? null;
    return {
      sourceType: 'GITHUB',
      title: r.full_name,
      url: r.html_url,
      author: r.owner.login,
      repository: r.full_name,
      publishedAt: r.pushed_at,
      summary: r.description ?? '(no description)',
      relevantConcept: `Matched search "${query}"`,
      license: spdx,
      termsConcerns: licenseConcern(spdx),
      github: { stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, lastPush: r.pushed_at, archived: r.archived, language: r.language, topics: r.topics ?? [] },
      knownLimitations: r.archived ? 'Repository is archived (no longer maintained).' : '',
      monitorCategory: classify('GITHUB', text),
      relevance: relevance(text),
      tags: r.topics ?? [],
    } satisfies ResearchItem;
  });
}

// ───────────────────────────────────────────────────────────────── arXiv ──

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1] as string) : null;
}

/** Minimal Atom parser for the arXiv API (title, id, dates, authors, summary). */
export function parseArxivAtom(xml: string): ResearchItem[] {
  const entries = xml.split('<entry>').slice(1).map((e) => e.split('</entry>')[0] as string);
  const out: ResearchItem[] = [];
  for (const e of entries) {
    const id = tag(e, 'id');
    const title = tag(e, 'title');
    if (!id || !title || !/^https?:\/\/arxiv\.org\//.test(id)) continue;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1] as string));
    const summary = tag(e, 'summary') ?? '';
    const text = `${title} ${summary}`;
    out.push({
      sourceType: 'PAPER',
      title,
      url: id.replace(/^http:/, 'https:'),
      author: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
      publishedAt: tag(e, 'published'),
      summary: summary.slice(0, 1200),
      relevantConcept: 'Academic research',
      license: null,
      termsConcerns: 'Papers describe methods; implement independently and cite the source.',
      monitorCategory: 'NEW_RESEARCH',
      relevance: relevance(text),
    });
  }
  return out;
}

export async function searchArxiv(http: HttpClient, query: string, max = 10): Promise<ResearchItem[]> {
  const raw = await http.request('https://export.arxiv.org/api/query', { source: 'arxiv.api', query: { search_query: query, sortBy: 'submittedDate', sortOrder: 'descending', max_results: max }, raw: true });
  return parseArxivAtom(String(raw));
}

// ─────────────────────────────────────────────────────────── Hacker News ──

const hn = z.object({
  hits: z.array(z.object({ objectID: z.string(), title: z.string().nullable(), url: z.string().nullable().optional(), author: z.string().nullable(), created_at: z.string(), points: z.number().nullable().optional() })),
});

export async function searchHackerNews(http: HttpClient, query: string, max = 15): Promise<ResearchItem[]> {
  const res = await http.json('https://hn.algolia.com/api/v1/search_by_date', hn, { source: 'hackernews.algolia', query: { query, tags: 'story', hitsPerPage: max } });
  return res.hits
    .filter((h) => h.title)
    .map((h) => {
      const title = h.title as string;
      return {
        sourceType: 'NEWS',
        title,
        url: h.url && /^https?:\/\//.test(h.url) ? h.url : `https://news.ycombinator.com/item?id=${h.objectID}`,
        author: h.author,
        publishedAt: h.created_at,
        summary: `Hacker News story${h.points ? ` (${h.points} points)` : ''}.`,
        relevantConcept: `Matched "${query}"`,
        monitorCategory: classify('NEWS', title),
        relevance: relevance(title),
      } satisfies ResearchItem;
    });
}

// ──────────────────────────────────────────────────────────── the monitor ──

export interface MonitorResult {
  items: ResearchItem[];
  errors: string[];
}

/** Run every source for every topic; one failing source never hides the others. */
export async function runResearchMonitor(http: HttpClient, opts: { topics?: string[]; githubToken?: string; minRelevance?: number } = {}): Promise<MonitorResult> {
  const topics = opts.topics ?? DEFAULT_TOPICS;
  const items: ResearchItem[] = [];
  const errors: string[] = [];
  const guard = async (label: string, fn: () => Promise<ResearchItem[]>) => {
    try {
      items.push(...(await fn()));
    } catch (e) {
      errors.push(`${label}: ${describeError(e).message}`);
    }
  };
  for (const [i, t] of topics.entries()) {
    try {
      items.push(...(await searchGitHub(http, t, { token: opts.githubToken })));
    } catch (e) {
      errors.push(`github "${t}": ${describeError(e).message}`);
      // Every further search would fail the same way and only extend the lockout.
      if (e instanceof ExternalApiError && e.kind === 'RATE_LIMITED') {
        const left = topics.length - i - 1;
        if (left > 0) errors.push(`github: skipped ${left} remaining search(es) after the rate limit${opts.githubToken ? '' : ' (set GITHUB_TOKEN for 30 searches/min instead of 10)'}`);
        break;
      }
    }
  }
  await guard('arxiv q-fin.TR', () => searchArxiv(http, 'cat:q-fin.TR AND (all:"market making" OR all:arbitrage OR all:"prediction market")'));
  await guard('arxiv agents', () => searchArxiv(http, 'all:"LLM agent" AND all:business'));
  for (const t of ['Show HN automation', 'prediction market', 'AI agent startup']) await guard(`hn "${t}"`, () => searchHackerNews(http, t));
  const min = opts.minRelevance ?? 0.1;
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    if (seen.has(i.url) || (i.relevance ?? 0) < min) return false;
    seen.add(i.url);
    return true;
  });
  return { items: unique.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0)), errors };
}
