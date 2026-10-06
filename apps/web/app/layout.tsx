import { Bell } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmergencyStop } from '@/components/emergency-stop';
import { Brand, MobileNav, Nav } from '@/components/nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge, HealthDot } from '@/components/ui';
import { ApiError, apiGet } from '@/lib/api';
import type { Notifications, SystemHealth } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Automated Opportunity Center', template: '%s · Opportunity Center' },
  description: 'Research, simulate, backtest and paper-test automated business and trading ideas. Paper / simulation only.',
  robots: { index: false, follow: false },
};

/** Runs before paint so a stored light theme does not flash. */
const THEME_SCRIPT = `try{if(localStorage.getItem('aoc-theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

async function chrome(): Promise<{ health: SystemHealth | null; unread: number; error: string | null }> {
  try {
    const [health, unread] = await Promise.all([apiGet<SystemHealth>('/v1/system/health'), apiGet<Notifications>('/v1/notifications', { unread: true })]);
    return { health, unread: unread.length, error: null };
  } catch (e) {
    return { health: null, unread: 0, error: e instanceof ApiError ? e.message : 'API error' };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { health, unread, error } = await chrome();
  const system = health?.components.find((c) => c.component === 'System');
  const stop = health?.emergencyStop ?? false;
  const stopReason = system?.detail.startsWith('EMERGENCY STOP') ? system.detail.replace(/^EMERGENCY STOP engaged: /, '') : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
            <Brand />
            <Nav />
            <div className="mt-auto space-y-2 border-t border-border p-4 text-[11px] text-muted">
              <p>
                <strong className="text-text">PAPER = DEFAULT.</strong> LIVE = DISABLED. No real money, orders or payouts.
              </p>
              <p>Results are historical, simulated, paper, estimated or DEMO — always labelled. Nothing here is a profit guarantee.</p>
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border bg-bg/90 px-4 py-2.5 backdrop-blur md:px-6">
              <MobileNav />
              <Badge tone="blue" title="Paper trading and simulation only">
                Paper mode
              </Badge>
              <Badge tone="gray" title="No live executor exists in this build">
                Live disabled
              </Badge>
              {health ? (
                <Link href="/system" className="text-xs text-muted hover:text-text" title={system?.detail}>
                  <HealthDot status={system?.status ?? 'UNKNOWN'} label={`System ${system?.status?.toLowerCase() ?? 'unknown'}`} />
                </Link>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <Link href="/system#notifications" className="relative rounded-md border border-border p-1.5 text-muted hover:text-text" aria-label={`${unread} unread notifications`}>
                  <Bell className="size-4" aria-hidden />
                  {unread > 0 ? <span className="absolute -top-1.5 -right-1.5 rounded-full bg-negative px-1 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span> : null}
                </Link>
                <ThemeToggle />
                <EmergencyStop engaged={stop} reason={stopReason} />
              </div>
            </header>
            {stop ? (
              <div className="border-b border-negative/40 bg-negative/15 px-6 py-2 text-[13px] font-semibold text-negative" role="alert">
                EMERGENCY STOP ENGAGED — automated experiments are paused and no paper order is accepted. {stopReason ? `Reason: ${stopReason}` : ''}
              </div>
            ) : null}
            {error ? (
              <div className="border-b border-warning/40 bg-warning/10 px-6 py-2 text-[13px] text-warning" role="alert">
                {error}
              </div>
            ) : null}
            <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
