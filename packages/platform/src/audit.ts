import { describeError, type ActorType, type AuditAction } from '@aoc/core';
import { auditLogs, systemEvents, type DbOrTx } from '@aoc/database';

export interface Actor {
  type: ActorType;
  id: string;
}

export const SYSTEM: Actor = { type: 'SYSTEM', id: 'system' };
export const WORKER: Actor = { type: 'WORKER', id: 'worker' };

export async function audit(
  db: DbOrTx,
  actor: Actor,
  action: AuditAction,
  entity: { type: string; id?: string | null; experimentId?: string | null },
  details: Record<string, unknown> = {},
  requestId?: string,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: actor.type,
    actorId: actor.id,
    action,
    entityType: entity.type,
    entityId: entity.id ?? null,
    experimentId: entity.experimentId ?? null,
    details,
    requestId: requestId ?? null,
  });
}

export type EventLevel = 'INFO' | 'WARN' | 'ERROR';

export async function recordEvent(
  db: DbOrTx,
  level: EventLevel,
  component: string,
  eventType: string,
  message: string,
  details: Record<string, unknown> = {},
  experimentId?: string | null,
): Promise<void> {
  await db.insert(systemEvents).values({ level, component, eventType, message: message.slice(0, 2000), details, experimentId: experimentId ?? null });
}

/** Record an error as a system event and an audit entry; never throws. */
export async function recordError(db: DbOrTx, component: string, err: unknown, context: Record<string, unknown> = {}, experimentId?: string | null): Promise<void> {
  const d = describeError(err);
  try {
    await recordEvent(db, 'ERROR', component, d.code, d.message, { ...context, error: d }, experimentId);
    await audit(db, SYSTEM, 'ERROR_OCCURRED', { type: component, experimentId }, { ...context, error: d });
  } catch (e) {
    process.stderr.write(`[platform] could not record error from ${component}: ${describeError(e).message}; original: ${d.message}\n`);
  }
}
