import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-surface p-6">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This page or record does not exist (it may have been archived or the link is wrong).</p>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        Back to the dashboard
      </Link>
    </div>
  );
}
