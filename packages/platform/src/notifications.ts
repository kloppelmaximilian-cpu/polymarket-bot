import { describeError, type NotificationType } from '@aoc/core';
import { notifications, type DbOrTx } from '@aoc/database';
import { asc, eq } from 'drizzle-orm';
import type { PlatformContext } from './context';

export type Severity = 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';

/**
 * Record an in-app notification inside the caller's transaction (so a
 * rolled-back change never produces a notification). Webhook delivery
 * happens later, outside any transaction, in `deliverPendingNotifications`.
 */
export async function notify(
  ctx: PlatformContext,
  n: { type: NotificationType; title: string; body?: string; severity?: Severity; experimentId?: string | null },
  db: DbOrTx = ctx.db,
): Promise<void> {
  await db.insert(notifications).values({
    type: n.type,
    title: n.title.slice(0, 300),
    body: (n.body ?? '').slice(0, 2000),
    severity: n.severity ?? 'INFO',
    experimentId: n.experimentId ?? null,
    deliveryStatus: ctx.config.NOTIFY_WEBHOOK_URL ? 'PENDING' : 'SKIPPED',
  });
}

/** Send pending notifications to the configured webhook (generic JSON, Slack or Discord). */
export async function deliverPendingNotifications(ctx: PlatformContext, limit = 50): Promise<{ sent: number; failed: number }> {
  const url = ctx.config.NOTIFY_WEBHOOK_URL;
  if (!url) return { sent: 0, failed: 0 };
  const pending = await ctx.db.select().from(notifications).where(eq(notifications.deliveryStatus, 'PENDING')).orderBy(asc(notifications.createdAt)).limit(limit);
  let sent = 0;
  let failed = 0;
  for (const n of pending) {
    const text = `[${n.severity}] ${n.title}${n.body ? ` — ${n.body}` : ''}`;
    const payload =
      ctx.config.NOTIFY_WEBHOOK_FORMAT === 'slack'
        ? { text }
        : ctx.config.NOTIFY_WEBHOOK_FORMAT === 'discord'
          ? { content: text.slice(0, 1900) }
          : { type: n.type, title: n.title, body: n.body, severity: n.severity, experimentId: n.experimentId, at: n.createdAt.toISOString() };
    try {
      const res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        sent++;
        await ctx.db.update(notifications).set({ deliveryStatus: 'SENT', deliveredAt: new Date() }).where(eq(notifications.id, n.id));
      } else {
        failed++;
        await ctx.db.update(notifications).set({ deliveryStatus: 'FAILED', deliveryError: `HTTP ${res.status}` }).where(eq(notifications.id, n.id));
      }
    } catch (e) {
      failed++;
      await ctx.db.update(notifications).set({ deliveryStatus: 'FAILED', deliveryError: describeError(e).message }).where(eq(notifications.id, n.id));
      ctx.logger.warn({ err: describeError(e) }, 'webhook delivery failed');
    }
  }
  return { sent, failed };
}
