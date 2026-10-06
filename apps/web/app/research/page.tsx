import Link from 'next/link';
import { ActionButton, ActionForm, Field, Submit } from '@/components/forms';
import { Badge, Card, Empty, Notice, PageHeader, Table, Td, Th, clsx } from '@/components/ui';
import { addIdea, addResearchSource, convertIdea, generateIdeas, runResearchMonitor } from '@/lib/actions';
import { apiGet } from '@/lib/api';
import { CATEGORIES, IDEA_FOCUS, IDEA_STATUSES, SOURCE_TYPES } from '@/lib/constants';
import { ago, humanize, num, usd } from '@/lib/format';
import { one, type Experiment, type Ideas, type ResearchSources, type SearchParams, type Settings, type Strategies } from '@/lib/types';

export const metadata = { title: 'Research & ideas' };

export default async function ResearchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tab = one(sp.tab) === 'sources' ? 'sources' : 'ideas';
  const search = one(sp.search) ?? '';
  const [ideas, sources, strategies, experiments, settings] = await Promise.all([
    apiGet<Ideas>('/v1/ideas', { search: tab === 'ideas' ? search : undefined, status: one(sp.status), category: one(sp.category) }),
    apiGet<ResearchSources>('/v1/research/sources', { search: tab === 'sources' ? search : undefined, sourceType: one(sp.sourceType), limit: 500 }),
    apiGet<Strategies>('/v1/strategies'),
    apiGet<Experiment[]>('/v1/experiments', { sort: 'name', dir: 'asc' }),
    apiGet<Settings>('/v1/settings'),
  ]);
  const llm = settings.config.IDEA_GENERATOR_LLM_ENABLED === true && settings.config.ANTHROPIC_API_KEY !== undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Research & ideas"
        subtitle="The idea database and the research database. Sources are stored with licence and terms notes; foreign code is never copied — ideas are re-implemented as our own modules."
        actions={<ActionButton action={runResearchMonitor}>Run research monitor</ActionButton>}
      />
      <div className="flex gap-1 border-b border-border">
        {(['ideas', 'sources'] as const).map((t) => (
          <Link key={t} href={`/research?tab=${t}`} className={clsx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium', tab === t ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}>
            {t === 'ideas' ? `Ideas (${ideas.length})` : `Sources (${sources.length})`}
          </Link>
        ))}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value={tab} />
        <input name="search" defaultValue={search} placeholder="Search…" aria-label="Search" />
        {tab === 'ideas' ? (
          <>
            <select name="status" defaultValue={one(sp.status) ?? ''} aria-label="Status">
              <option value="">Any status</option>
              {IDEA_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
            <select name="category" defaultValue={one(sp.category) ?? ''} aria-label="Category">
              <option value="">Any category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <select name="sourceType" defaultValue={one(sp.sourceType) ?? ''} aria-label="Source type">
            <option value="">Any type</option>
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px]">
          Filter
        </button>
      </form>

      {tab === 'ideas' ? (
        <>
          <Card
            title="Idea generator"
            subtitle={llm ? 'Uses Claude with structured output; every generated idea is stored with its origin and starts unverified.' : 'Uses the built-in catalogue of idea templates (set ANTHROPIC_API_KEY and IDEA_GENERATOR_LLM_ENABLED=true to use Claude).'}
          >
            <ActionForm action={generateIdeas} className="flex flex-wrap items-end gap-3">
              <Field label="Focus">
                <select name="focus" defaultValue="any">
                  {IDEA_FOCUS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="How many">
                <input name="count" type="number" min={1} max={25} defaultValue={10} />
              </Field>
              <Field label="Auto-convert at most" hint="best testable ideas become DISCOVERED experiments (you start them)">
                <input name="maxConvert" type="number" min={0} max={10} defaultValue={2} />
              </Field>
              <Submit variant="primary">Generate ideas</Submit>
            </ActionForm>
          </Card>
          <Card title="Ideas" bodyClassName="p-0">
            {ideas.length === 0 ? (
              <div className="p-4">
                <Empty title="No ideas">Generate some or add one below.</Empty>
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Idea</Th>
                    <Th>Category</Th>
                    <Th>Origin</Th>
                    <Th>Status</Th>
                    <Th title="automation / complexity / scalability / testability (0–100, self-assessed)">A / C / S / T</Th>
                    <Th>Capital</Th>
                    <Th>Risks</Th>
                    <Th>Module</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {ideas.map((i) => (
                    <tr key={i.id}>
                      <Td className="max-w-md min-w-64">
                        <div className="font-medium">{i.name}</div>
                        <p className="mt-0.5 line-clamp-3 text-xs text-muted">{i.description}</p>
                        {i.revenueSource ? <p className="mt-0.5 text-[11px] text-muted">Revenue: {i.revenueSource}</p> : null}
                      </Td>
                      <Td className="text-xs text-muted">{humanize(i.category)}</Td>
                      <Td>
                        <Badge tone={i.origin === 'LLM' ? 'purple' : 'gray'}>{i.origin}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={i.status === 'CONVERTED' ? 'green' : i.status === 'REJECTED' ? 'red' : 'sky'}>{i.status}</Badge>
                      </Td>
                      <Td className="num text-xs whitespace-nowrap">
                        {num(i.automationScore, 0)} / {num(i.complexityScore, 0)} / {num(i.scalabilityScore, 0)} / {num(i.testabilityScore, 0)}
                      </Td>
                      <Td className="num text-xs whitespace-nowrap">{i.estimatedCapital === null ? 'NO DATA' : usd(i.estimatedCapital, { digits: 0 })}</Td>
                      <Td className="max-w-xs text-[11px] text-muted">
                        {[...(i.risks ?? []), ...(i.regulatoryRisks ?? []).map((x) => `⚖ ${x}`)].slice(0, 4).join(' · ') || '—'}
                      </Td>
                      <Td className="font-mono text-[11px] text-muted">{i.suggestedStrategyId ?? '—'}</Td>
                      <Td className="whitespace-nowrap">
                        {i.experimentId ? (
                          <Link href={`/experiments/${i.experimentId}`} className="text-xs text-accent hover:underline">
                            experiment →
                          </Link>
                        ) : (
                          <ActionForm action={convertIdea} hidden={{ id: i.id }} className="flex flex-col gap-1">
                            <select name="strategyId" defaultValue={i.suggestedStrategyId ?? ''} aria-label="Module" className="max-w-44 text-xs">
                              <option value="" disabled>
                                choose module…
                              </option>
                              {strategies.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.id}
                                </option>
                              ))}
                            </select>
                            <label className="flex items-center gap-1 text-[11px] text-muted">
                              <input type="checkbox" name="startResearch" /> start
                            </label>
                            <Submit>Convert</Submit>
                          </ActionForm>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Add an idea" subtitle="Scores are your own estimates (0–100) and are shown as such.">
            <ActionForm action={addIdea} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Name">
                <input name="name" required minLength={3} maxLength={200} />
              </Field>
              <Field label="Category">
                <select name="category" defaultValue="EXPERIMENTAL">
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Module to test it with (optional)">
                <select name="suggestedStrategyId" defaultValue="">
                  <option value="">none yet</option>
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Source URL (optional)">
                <input name="sourceUrl" type="url" placeholder="https://…" />
              </Field>
              <Field label="Description" className="md:col-span-2">
                <textarea name="description" required minLength={10} rows={3} />
              </Field>
              <Field label="Revenue source">
                <input name="revenueSource" maxLength={500} />
              </Field>
              <Field label="Estimated capital, USD">
                <input name="estimatedCapital" type="number" min={0} step="any" />
              </Field>
              {(['automationScore', 'complexityScore', 'scalabilityScore', 'testabilityScore'] as const).map((k) => (
                <Field key={k} label={humanize(k.replace('Score', '').toUpperCase())}>
                  <input name={k} type="number" min={0} max={100} />
                </Field>
              ))}
              <Field label="Risks (one per line)">
                <textarea name="risks" rows={2} />
              </Field>
              <Field label="Dependencies (one per line)">
                <textarea name="dependencies" rows={2} />
              </Field>
              <Field label="Regulatory / ToS risks (one per line)" className="md:col-span-2">
                <textarea name="regulatoryRisks" rows={2} />
              </Field>
              <div className="col-span-full">
                <Submit variant="primary">Add idea</Submit>
              </div>
            </ActionForm>
          </Card>
        </>
      ) : (
        <>
          <Card title="Research database" bodyClassName="p-0">
            {sources.length === 0 ? (
              <div className="p-4">
                <Empty title="No sources" />
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th>Type</Th>
                    <Th>Category</Th>
                    <Th>Licence / terms</Th>
                    <Th>Repository</Th>
                    <Th>Found</Th>
                    <Th>Experiments</Th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <Td className="max-w-lg min-w-72">
                        <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
                          {s.title}
                        </a>
                        {s.summary ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.summary}</p> : null}
                        {s.relevantConcept ? <p className="mt-0.5 text-[11px] text-muted">Concept: {s.relevantConcept}</p> : null}
                      </Td>
                      <Td className="text-xs">{humanize(s.sourceType)}</Td>
                      <Td className="text-xs text-muted">{s.monitorCategory ? humanize(s.monitorCategory) : '—'}</Td>
                      <Td className="max-w-xs text-xs">
                        {s.license ?? <span className="text-muted">unknown</span>}
                        {s.termsConcerns ? <p className="text-[11px] text-warning">{s.termsConcerns}</p> : null}
                      </Td>
                      <Td className="text-xs text-muted">
                        {s.github ? (
                          <span>
                            ★ {num(s.github.stars, 0)} · {s.github.archived ? 'archived' : `pushed ${ago(s.github.lastPush ?? null)}`}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td className="text-xs whitespace-nowrap text-muted">
                        {ago(s.foundAt)} · {s.origin.toLowerCase()}
                      </Td>
                      <Td className="text-xs">
                        {s.experiments.length
                          ? s.experiments.map((x) => (
                              <Link key={x.id} href={`/experiments/${x.id}`} className="block text-accent hover:underline">
                                {x.name}
                              </Link>
                            ))
                          : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Add a source">
            <Notice tone="gray">Record what a source teaches and under which licence or terms — the platform re-implements concepts, it does not copy code.</Notice>
            <ActionForm action={addResearchSource} className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Title">
                <input name="title" required minLength={3} maxLength={500} />
              </Field>
              <Field label="URL">
                <input name="url" type="url" required placeholder="https://…" />
              </Field>
              <Field label="Type">
                <select name="sourceType" defaultValue="WEBSITE">
                  {SOURCE_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Link to experiment (optional)">
                <select name="experimentId" defaultValue="">
                  <option value="">—</option>
                  {experiments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Summary" className="md:col-span-2">
                <textarea name="summary" rows={2} maxLength={4000} />
              </Field>
              <Field label="Relevant concept">
                <input name="relevantConcept" maxLength={1000} />
              </Field>
              <Field label="Licence">
                <input name="license" maxLength={100} placeholder="MIT, Apache-2.0, proprietary…" />
              </Field>
              <Field label="Terms / ToS concerns" className="md:col-span-2">
                <input name="termsConcerns" maxLength={2000} />
              </Field>
              <div className="col-span-full">
                <Submit variant="primary">Add source</Submit>
              </div>
            </ActionForm>
          </Card>
        </>
      )}
    </div>
  );
}
