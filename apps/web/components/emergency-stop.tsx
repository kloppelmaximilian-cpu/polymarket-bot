'use client';

import { OctagonX, ShieldCheck } from 'lucide-react';
import { useActionState, useEffect, useRef, useState } from 'react';
import { engageEmergencyStop, releaseEmergencyStop, type ActionState } from '@/lib/actions';
import { Result, Submit } from './forms';

const INITIAL: ActionState = { ok: null, message: '' };

/** The always-visible EMERGENCY STOP control (and release when engaged). */
export function EmergencyStop({ engaged, reason }: { engaged: boolean; reason: string | null }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [stopState, stop] = useActionState(engageEmergencyStop, INITIAL);
  const [releaseState, release] = useActionState(releaseEmergencyStop, INITIAL);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (stopState.ok || releaseState.ok) setOpen(false);
  }, [stopState, releaseState]);

  return (
    <>
      {engaged ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-md border border-negative bg-negative/15 px-3 py-1.5 text-[13px] font-bold tracking-wide text-negative uppercase" title={reason ?? undefined}>
          <OctagonX className="size-4" aria-hidden /> Stop engaged — release…
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-md border border-negative bg-negative px-3 py-1.5 text-[13px] font-bold tracking-wide text-white uppercase shadow-sm hover:opacity-90">
          <OctagonX className="size-4" aria-hidden /> Emergency stop
        </button>
      )}
      <dialog ref={dialog} onClose={() => setOpen(false)} className="m-auto w-[min(32rem,92vw)] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/60">
        {engaged ? (
          <form action={release} className="flex flex-col gap-3 p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="size-5 text-positive" aria-hidden /> Release the emergency stop
            </h2>
            <p className="text-sm text-muted">Engaged because: {reason ?? '—'}. Releasing lets the worker run acting jobs again. Paused experiments stay paused unless you choose to resume them.</p>
            <input name="reason" required minLength={3} placeholder="Why is it safe to continue?" aria-label="Reason" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="resumePaused" /> Resume the experiments the stop paused
            </label>
            <Result state={releaseState} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-[13px]">
                Cancel
              </button>
              <Submit variant="primary">Release</Submit>
            </div>
          </form>
        ) : (
          <form action={stop} className="flex flex-col gap-3 p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold text-negative">
              <OctagonX className="size-5" aria-hidden /> Emergency stop
            </h2>
            <ul className="list-disc pl-5 text-sm text-muted">
              <li>pauses every automated experiment</li>
              <li>cancels every open paper order (positions stay, marked to market)</li>
              <li>blocks new paper orders and halts acting worker jobs until released</li>
            </ul>
            <input name="reason" required minLength={3} placeholder="Reason (recorded in the audit log)" aria-label="Reason" autoFocus />
            <Result state={stopState} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-[13px]">
                Cancel
              </button>
              <Submit variant="danger">Stop everything</Submit>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
