'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, apiSend } from './api';
import { basicAuthOk } from './auth';

export interface ActionState {
  ok: boolean | null;
  message: string;
}

/** Server Actions are reachable by direct POST: re-check auth inside every one. */
async function guard(): Promise<void> {
  if (!basicAuthOk((await headers()).get('authorization'))) throw new Error('unauthorized');
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function run(fn: () => Promise<string>, paths: string[] = ['/']): Promise<ActionState> {
  try {
    await guard();
    const message = await fn();
    for (const p of paths) revalidatePath(p, 'layout');
    return { ok: true, message };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: `${e.code}: ${e.message}` };
    return { ok: false, message: (e as Error).message };
  }
}

// ───────────────────────────────────────────────────────────── safety ──

export async function engageEmergencyStop(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const reason = str(fd, 'reason');
    if (reason.length < 3) throw new Error('Please give a reason (at least 3 characters).');
    const r = await apiSend<{ paused: number; cancelledOrders: number }>('POST', '/v1/risk/emergency-stop', { reason });
    return `EMERGENCY STOP engaged: ${r.paused} experiment(s) paused, ${r.cancelledOrders} paper order(s) cancelled.`;
  });
}

export async function releaseEmergencyStop(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const reason = str(fd, 'reason');
    if (reason.length < 3) throw new Error('Please give a reason (at least 3 characters).');
    const r = await apiSend<{ resumed: number }>('POST', '/v1/risk/emergency-stop/release', { reason, resumePaused: fd.get('resumePaused') === 'on' });
    return `Emergency stop released${r.resumed ? `, ${r.resumed} experiment(s) resumed` : ''}.`;
  });
}

// ──────────────────────────────────────────────────────── experiments ──

export async function experimentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const id = str(fd, 'id');
    const action = str(fd, 'action');
    const res = await apiSend<{ step?: { from: string; to: string | null; note: string }; experiment?: { status: string } }>('POST', `/v1/experiments/${id}/actions`, { action, reason: str(fd, 'reason') || `${action} from the dashboard` });
    if (res.step) return `${res.step.from} → ${res.step.to ?? 'no change'}: ${res.step.note}`;
    return `Status: ${res.experiment?.status ?? 'updated'}`;
  });
}

export async function createExperiment(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const state = await run(async () => {
    const capital = Number(str(fd, 'capital'));
    const body: Record<string, unknown> = { strategyId: str(fd, 'strategyId'), startResearch: fd.get('startResearch') === 'on' };
    if (str(fd, 'name')) body.name = str(fd, 'name');
    if (str(fd, 'description')) body.description = str(fd, 'description');
    if (capital > 0) body.capital = capital;
    const res = await apiSend<{ experiment: { id: string } }>('POST', '/v1/experiments', body);
    id = res.experiment.id;
    return 'created';
  });
  if (state.ok && id) redirect(`/experiments/${id}`);
  return state;
}

export async function queueLab(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const r = await apiSend<{ queued: boolean }>('POST', `/v1/experiments/${str(fd, 'id')}/lab`);
    return r.queued ? 'Strategy Lab run queued; results appear as a LAB run and, if it helps, a CANDIDATE version.' : 'A Strategy Lab run for this experiment is already queued.';
  });
}

export async function flattenPositions(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const r = await apiSend<{ closedPositions: number; note: string }>('POST', `/v1/experiments/${str(fd, 'id')}/flatten`, { reason: str(fd, 'reason') || 'manual flatten from the dashboard' });
    return `${r.closedPositions} paper position(s) closed. ${r.note}`;
  });
}

export async function createVersion(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    let params: Record<string, unknown> | undefined;
    const raw = str(fd, 'params');
    if (raw) {
      try {
        params = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error('Parameters must be valid JSON, e.g. {"lookbackBars": 48}');
      }
    }
    const v = await apiSend<{ label: string; status: string }>('POST', `/v1/experiments/${str(fd, 'id')}/versions`, {
      params,
      changeNote: str(fd, 'changeNote'),
      bump: str(fd, 'bump') === 'major' ? 'major' : 'minor',
      status: str(fd, 'status') === 'CANDIDATE' ? 'CANDIDATE' : 'ACTIVE',
    });
    return `Version ${v.label} created (${v.status}).`;
  });
}

export async function promoteVersion(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await apiSend('POST', `/v1/experiments/${str(fd, 'id')}/versions/${str(fd, 'versionId')}/promote`);
    return 'Version promoted; the experiment is re-evaluated from a fresh backtest.';
  });
}

export async function updateRiskLimits(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const keys = ['maxCapital', 'maxDailyLoss', 'maxDrawdownPct', 'maxExposure', 'maxPositions', 'maxOrdersPerDay', 'maxOrderNotional', 'maxApiSpend', 'maxExperimentSpend'];
    const body: Record<string, number> = {};
    for (const k of keys) {
      const v = str(fd, k);
      if (v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      body[k] = n;
    }
    await apiSend('PUT', `/v1/experiments/${str(fd, 'id')}/risk-limits`, body);
    return 'Risk limits saved (audited).';
  });
}

export async function updateCompliance(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await apiSend('PUT', `/v1/experiments/${str(fd, 'id')}/compliance/${str(fd, 'item')}`, { state: str(fd, 'state'), note: str(fd, 'note') });
    return str(fd, 'state') === 'BLOCKER' ? 'Recorded as BLOCKER: the experiment is now FAILED.' : 'Compliance review recorded.';
  });
}

// ───────────────────────────────────────────────────────────── research ──

export async function addResearchSource(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const body: Record<string, unknown> = { sourceType: str(fd, 'sourceType') || 'WEBSITE', title: str(fd, 'title'), url: str(fd, 'url'), summary: str(fd, 'summary') };
    for (const k of ['license', 'relevantConcept', 'termsConcerns']) if (str(fd, k)) body[k] = str(fd, k);
    if (str(fd, 'experimentId')) body.experimentId = str(fd, 'experimentId');
    const r = await apiSend<{ created: boolean }>('POST', '/v1/research/sources', body);
    return r.created ? 'Source added.' : 'This URL is already in the research database.';
  });
}

export async function addIdea(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const list = (k: string) => str(fd, k).split('\n').map((s) => s.trim()).filter(Boolean);
    const optNum = (k: string) => (str(fd, k) === '' ? null : Number(str(fd, k)));
    const body = {
      name: str(fd, 'name'),
      category: str(fd, 'category'),
      description: str(fd, 'description'),
      revenueSource: str(fd, 'revenueSource'),
      estimatedCapital: optNum('estimatedCapital'),
      automationScore: optNum('automationScore'),
      complexityScore: optNum('complexityScore'),
      scalabilityScore: optNum('scalabilityScore'),
      testabilityScore: optNum('testabilityScore'),
      risks: list('risks'),
      dependencies: list('dependencies'),
      regulatoryRisks: list('regulatoryRisks'),
      suggestedStrategyId: str(fd, 'suggestedStrategyId') || null,
      ...(str(fd, 'sourceUrl') ? { sourceUrl: str(fd, 'sourceUrl') } : {}),
    };
    const r = await apiSend<{ created: boolean }>('POST', '/v1/ideas', body);
    return r.created ? 'Idea added.' : 'An idea with this name already exists.';
  });
}

export async function convertIdea(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const state = await run(async () => {
    const r = await apiSend<{ experimentId: string }>('POST', `/v1/ideas/${str(fd, 'id')}/convert`, { strategyId: str(fd, 'strategyId') || undefined, startResearch: fd.get('startResearch') === 'on' });
    id = r.experimentId;
    return 'Experiment created.';
  });
  if (state.ok && id) redirect(`/experiments/${id}`);
  return state;
}

export async function generateIdeas(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const r = await apiSend<{ queued: boolean }>('POST', '/v1/ideas/generate', { focus: str(fd, 'focus') || 'any', count: Number(str(fd, 'count') || 10), maxConvert: Number(str(fd, 'maxConvert') || 2) });
    return r.queued ? 'Idea generator queued; new ideas appear when the worker has run it.' : 'The idea generator is already queued.';
  });
}

export async function runResearchMonitor(): Promise<ActionState> {
  return run(async () => {
    const r = await apiSend<{ queued: boolean }>('POST', '/v1/research/monitor');
    return r.queued ? 'Research monitor queued.' : 'Already queued.';
  });
}

// ─────────────────────────────────────────────────────────────── system ──

export async function queueJob(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const name = str(fd, 'name');
    const r = await apiSend<{ queued: boolean }>('POST', `/v1/jobs/${name}`, {});
    return r.queued ? `${name} queued.` : `${name} is already queued.`;
  });
}

export async function probeDataSources(): Promise<ActionState> {
  return run(async () => {
    await apiSend('POST', '/v1/data-sources/probe');
    return 'Probe queued; statuses update when the worker has run it.';
  });
}

export async function markAllNotificationsRead(): Promise<ActionState> {
  return run(async () => {
    await apiSend('POST', '/v1/notifications/read', {});
    return 'All notifications marked as read.';
  });
}

export async function updateScoringWeights(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const body: Record<string, number> = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string' && v.trim() !== '' && !k.startsWith('$')) body[k] = Number(v);
    await apiSend('PUT', '/v1/settings/scoring-weights', body);
    return 'Scoring weights saved; scores update on the next recompute.';
  });
}

export async function updateGateThresholds(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const body: Record<string, number> = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string' && v.trim() !== '' && !k.startsWith('$')) body[k] = Number(v);
    await apiSend('PUT', '/v1/settings/gate-thresholds', body);
    return 'Quality-gate thresholds saved.';
  });
}
