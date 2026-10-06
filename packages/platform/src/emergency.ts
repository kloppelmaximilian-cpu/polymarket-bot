import { ValidationError, type ExperimentStatus } from '@aoc/core';
import { experiments, paperAccounts, riskEvents } from '@aoc/database';
import { PAPER_TRADING_STATUSES } from '@aoc/experiments';
import { and, eq, inArray, like } from 'drizzle-orm';
import { audit, recordError, type Actor } from './audit';
import type { PlatformContext } from './context';
import { transition } from './experiments';
import { notify } from './notifications';
import { cancelOpenOrders } from './paper-runner';
import { SETTING_KEYS, getEmergencyStop, putSetting, type EmergencyStopState } from './settings';

export const EMERGENCY_PREFIX = 'EMERGENCY STOP';

/**
 * EMERGENCY STOP: one switch that halts every automated experiment.
 *  - the flag is stored first, so the risk hook rejects every new paper
 *    order and the worker stops running haltable jobs immediately
 *  - every experiment in a paper-trading status is PAUSED
 *  - every open paper order is cancelled (positions stay, marked to market)
 * Releasing the stop does not resume anything by itself.
 */
export async function engageEmergencyStop(ctx: PlatformContext, reason: string, actor: Actor): Promise<{ state: EmergencyStopState; paused: number; cancelledOrders: number }> {
  if (!reason.trim()) throw new ValidationError('a reason is required');
  const state: EmergencyStopState = { engaged: true, reason, engagedAt: ctx.clock.now().toISOString(), engagedBy: actor.id, releasedAt: null };
  await putSetting(ctx.db, SETTING_KEYS.emergencyStop, state, actor.id);
  await audit(ctx.db, actor, 'EMERGENCY_STOP_ENGAGED', { type: 'system' }, { reason });
  await ctx.db.insert(riskEvents).values({ limitName: 'emergencyStop', severity: 'CRITICAL', message: `${EMERGENCY_PREFIX}: ${reason}`, action: 'EMERGENCY_STOP' });
  const running = await ctx.db.select().from(experiments).where(inArray(experiments.status, [...PAPER_TRADING_STATUSES]));
  let paused = 0;
  for (const exp of running) {
    try {
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PAUSED', { actor, by: 'USER', reason: `${EMERGENCY_PREFIX}: ${reason}` }));
      paused++;
    } catch (e) {
      await recordError(ctx.db, 'emergency-stop', e, {}, exp.id);
    }
  }
  let cancelledOrders = 0;
  const accounts = await ctx.db.select({ id: paperAccounts.id, experimentId: paperAccounts.experimentId }).from(paperAccounts).where(eq(paperAccounts.status, 'ACTIVE'));
  for (const a of accounts) {
    try {
      cancelledOrders += await cancelOpenOrders(ctx, a.id, 'emergency stop');
    } catch (e) {
      await recordError(ctx.db, 'emergency-stop', e, { accountId: a.id }, a.experimentId);
    }
  }
  await notify(ctx, { type: 'EMERGENCY_STOP', severity: 'CRITICAL', title: 'EMERGENCY STOP engaged', body: `${reason} — ${paused} experiment(s) paused, ${cancelledOrders} open paper order(s) cancelled.` });
  return { state, paused, cancelledOrders };
}

export async function releaseEmergencyStop(ctx: PlatformContext, reason: string, actor: Actor, opts: { resumePaused?: boolean } = {}): Promise<{ state: EmergencyStopState; resumed: number }> {
  const prev = await getEmergencyStop(ctx.db);
  if (!prev.engaged) throw new ValidationError('the emergency stop is not engaged');
  const state: EmergencyStopState = { ...prev, engaged: false, releasedAt: ctx.clock.now().toISOString() };
  await putSetting(ctx.db, SETTING_KEYS.emergencyStop, state, actor.id);
  await audit(ctx.db, actor, 'EMERGENCY_STOP_RELEASED', { type: 'system' }, { reason, resumePaused: !!opts.resumePaused });
  await ctx.db.update(riskEvents).set({ resolvedAt: ctx.clock.now() }).where(and(eq(riskEvents.limitName, 'emergencyStop'), eq(riskEvents.action, 'EMERGENCY_STOP')));
  let resumed = 0;
  if (opts.resumePaused) {
    const paused = await ctx.db.select().from(experiments).where(and(eq(experiments.status, 'PAUSED'), like(experiments.statusReason, `${EMERGENCY_PREFIX}%`)));
    for (const exp of paused) {
      const to = (exp.statusBeforePause as ExperimentStatus | null) ?? 'RESEARCHING';
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, to, { actor, by: 'USER', reason: `resumed after emergency stop release: ${reason}` }));
      resumed++;
    }
  }
  await notify(ctx, { type: 'EMERGENCY_STOP', severity: 'WARNING', title: 'Emergency stop released', body: `${reason}${opts.resumePaused ? ` — ${resumed} experiment(s) resumed` : ' — experiments stay paused until resumed individually'}` });
  return { state, resumed };
}
