'use client';

import { clsx } from 'clsx';
import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/lib/actions';

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const INITIAL: ActionState = { ok: null, message: '' };

export function Submit({ children, variant = 'secondary', confirm, className }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:cursor-wait disabled:opacity-60',
        variant === 'primary' && 'border-accent bg-accent text-white hover:opacity-90',
        variant === 'secondary' && 'border-border bg-surface-2 hover:bg-surface-3',
        variant === 'danger' && 'border-negative bg-negative text-white hover:opacity-90',
        className,
      )}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

export function Result({ state }: { state: ActionState }) {
  if (state.ok === null || !state.message) return null;
  return (
    <p role="status" className={clsx('text-xs', state.ok ? 'text-positive' : 'text-negative')}>
      {state.message}
    </p>
  );
}

/** A form bound to a Server Action, showing its result inline. */
export function ActionForm({ action, children, className, hidden }: { action: Action; children: ReactNode; className?: string; hidden?: Record<string, string> }) {
  const [state, formAction] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className={className}>
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      {children}
      <div className="mt-2 empty:hidden">
        <Result state={state} />
      </div>
    </form>
  );
}

/** One button that runs one action (e.g. pause, queue a job). */
export function ActionButton({ action, hidden, children, variant, confirm }: { action: Action; hidden?: Record<string, string>; children: ReactNode; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string }) {
  const [state, formAction] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <Submit variant={variant} confirm={confirm}>
        {children}
      </Submit>
      <Result state={state} />
    </form>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1 text-xs', className)}>
      <span className="font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
