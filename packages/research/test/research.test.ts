import { CATEGORIES, normalizeTitle } from '@aoc/core';
import { ALLOWED_HOSTS, HttpClient } from '@aoc/connectors';
import { describe, expect, it } from 'vitest';
import {
  SEED_SOURCES,
  catalogSize,
  classify,
  complianceSummary,
  defaultCompliance,
  generateCatalogIdeas,
  generateLlmIdeas,
  licenseConcern,
  parseArxivAtom,
  relevance,
  runResearchMonitor,
  searchGitHub,
} from '../src';

const http = (handler: (url: URL) => Response) =>
  new HttpClient({ fetch: (async (u: string | URL) => handler(new URL(String(u)))) as typeof fetch, allowedHosts: ALLOWED_HOSTS, sleep: async () => undefined, retries: 0 });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe('idea catalogue', () => {
  it('generates deterministic, distinct ideas and respects exclusions', () => {
    const a = generateCatalogIdeas({ seed: 's', count: 10 });
    const b = generateCatalogIdeas({ seed: 's', count: 10 });
    expect(a.map((i) => i.name)).toEqual(b.map((i) => i.name));
    expect(new Set(a.map((i) => normalizeTitle(i.name))).size).toBe(10);
    const exclude = new Set(a.map((i) => normalizeTitle(i.name)));
    const c = generateCatalogIdeas({ seed: 's', count: catalogSize(), exclude });
    expect(c.some((i) => exclude.has(normalizeTitle(i.name)))).toBe(false);
    expect(c.length).toBe(catalogSize() - 10);
  });

  it('filters by focus and keeps low-capital ideas cheap', () => {
    const low = generateCatalogIdeas({ seed: 'x', count: 50, focus: 'low-capital' });
    expect(low.length).toBeGreaterThanOrEqual(10);
    for (const i of low) expect(i.estimatedCapital!).toBeLessThanOrEqual(2000);
    const pm = generateCatalogIdeas({ seed: 'x', count: 50, focus: 'prediction-markets' });
    for (const i of pm) {
      expect(i.category).toBe('PREDICTION_MARKET');
      expect(i.suggestedStrategyId).toMatch(/^pm\./);
    }
  });

  it('labels every generated idea as hypothetical and lists risks', () => {
    for (const i of generateCatalogIdeas({ seed: 'y', count: catalogSize() })) {
      expect(i.origin).toBe('CATALOG');
      expect(i.notes.join()).toMatch(/hypothetical/);
      expect(i.risks.length).toBeGreaterThan(0);
      expect(CATEGORIES).toContain(i.category);
    }
  });
});

describe('compliance and licences', () => {
  it('starts every compliance item unreviewed', () => {
    for (const c of ['LEAD_GENERATION', 'PREDICTION_MARKET', 'EXPERIMENTAL'] as const) {
      const list = defaultCompliance(c);
      expect(list.length).toBeGreaterThan(0);
      expect(complianceSummary(list).unreviewed).toBe(list.length);
    }
    expect(defaultCompliance('LEAD_GENERATION').map((x) => x.item)).toContain('SPAM_RULES');
  });
  it('classifies licences', () => {
    expect(licenseConcern(null)).toMatch(/all rights reserved/);
    expect(licenseConcern('GPL-3.0')).toMatch(/copyleft/);
    expect(licenseConcern('MIT')).toMatch(/permissive/);
  });
  it('ships seed sources with URLs and targets', () => {
    for (const s of SEED_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.informs.length).toBeGreaterThan(0);
    }
  });
});

describe('research monitor', () => {
  // Shapes follow the GitHub REST search, arXiv Atom and HN Algolia documentation.
  const repo = { full_name: 'acme/pm-bot', html_url: 'https://github.com/acme/pm-bot', description: 'Polymarket market making bot with backtesting', stargazers_count: 120, forks_count: 10, open_issues_count: 3, pushed_at: '2026-09-01T00:00:00Z', archived: false, language: 'Python', topics: ['polymarket'], license: { spdx_id: 'GPL-3.0', name: 'GNU GPL v3' }, owner: { login: 'acme' } };
  const atom = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2601.00001v1</id><published>2026-01-02T00:00:00Z</published><title>Market Making in Prediction Markets &amp; Beyond</title><summary>We study arbitrage and market making.</summary><author><name>A. Author</name></author><author><name>B. Author</name></author></entry><entry><id>bad</id><title>x</title></entry></feed>`;

  it('parses GitHub results with licence concerns and relevance', async () => {
    const items = await searchGitHub(http(() => json({ total_count: 1, items: [repo] })), 'polymarket');
    expect(items[0]!.license).toBe('GPL-3.0');
    expect(items[0]!.termsConcerns).toMatch(/copyleft/);
    expect(items[0]!.monitorCategory).toBe('NEW_OPEN_SOURCE_PROJECT');
    expect(items[0]!.relevance!).toBeGreaterThan(0.3);
  });

  it('parses arXiv Atom and skips malformed entries', () => {
    const items = parseArxivAtom(atom);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Market Making in Prediction Markets & Beyond');
    expect(items[0]!.url).toBe('https://arxiv.org/abs/2601.00001v1');
    expect(items[0]!.author).toBe('A. Author, B. Author');
  });

  it('scores relevance and classifies news', () => {
    expect(relevance('cooking recipes')).toBe(0);
    expect(relevance('prediction market arbitrage bot')).toBeGreaterThan(0.4);
    expect(classify('NEWS', 'Show HN: a new API for order books')).toBe('NEW_API');
  });

  it('keeps going when one source fails and deduplicates', async () => {
    const res = await runResearchMonitor(
      http((url) => {
        if (url.hostname === 'api.github.com') return json({ total_count: 1, items: [repo] });
        if (url.hostname === 'export.arxiv.org') return new Response('boom', { status: 500 });
        return json({ hits: [{ objectID: '1', title: 'Show HN: prediction market API', url: 'https://example.org/x', author: 'u', created_at: '2026-01-01T00:00:00Z', points: 5 }] });
      }),
      { topics: ['a', 'b'] },
    );
    expect(res.items.filter((i) => i.url === repo.html_url)).toHaveLength(1);
    expect(res.items.some((i) => i.sourceType === 'NEWS')).toBe(true);
    expect(res.errors.join()).toMatch(/arxiv/);
  });
});

describe('LLM idea generator', () => {
  const fakeClient = (response: unknown) => ({ beta: { messages: { parse: async (params: Record<string, unknown>) => ({ ...(response as object), _params: params }) } } }) as never;

  it('maps structured output to hypothetical LLM ideas with clamped scores', async () => {
    const out = await generateLlmIdeas({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      focus: 'low-capital',
      count: 1,
      existingNames: [],
      client: fakeClient({ stop_reason: 'end_turn', model: 'claude-opus-5-5', parsed_output: { ideas: [{ name: 'X', category: 'MICRO_SAAS', description: 'd', revenueSource: 'subs', estimatedCapitalUsd: 300, automation: 140, complexity: -5, scalability: 50, testability: 60, risks: ['r'], dependencies: [], regulatoryRisks: [], howToTestCheaply: 'landing page' }] } }),
    });
    expect(out.ideas[0]!.origin).toBe('LLM');
    expect(out.ideas[0]!.automationScore).toBe(100);
    expect(out.ideas[0]!.complexityScore).toBe(0);
    expect(out.ideas[0]!.notes[0]).toMatch(/unverified/);
  });

  it('surfaces a refusal instead of returning nothing', async () => {
    await expect(
      generateLlmIdeas({ apiKey: 'k', model: 'claude-opus-5-5', focus: 'any', count: 1, existingNames: [], client: fakeClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, parsed_output: null, model: 'm' }) }),
    ).rejects.toThrow(/declined/);
  });
});
