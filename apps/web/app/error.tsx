'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const unreachable = /not reachable/i.test(error.message);
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-surface p-6">
      <h1 className="text-lg font-semibold">{unreachable ? 'The API is not reachable' : 'Something went wrong'}</h1>
      <p className="mt-2 text-sm text-muted">{error.message || 'An unexpected error occurred while loading this page.'}</p>
      {unreachable ? (
        <pre className="mt-3 rounded bg-surface-2 p-3 text-xs">pnpm dev            # API + worker + dashboard (PostgreSQL){'\n'}pnpm dev:embedded   # without Docker (embedded Postgres)</pre>
      ) : null}
      {error.digest ? <p className="mt-2 text-xs text-muted">Reference: {error.digest}</p> : null}
      <button type="button" onClick={reset} className="mt-4 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3">
        Try again
      </button>
    </div>
  );
}
