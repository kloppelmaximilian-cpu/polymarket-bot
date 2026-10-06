'use client';

import { clsx } from 'clsx';
import { Activity, BarChart3, Beaker, FlaskConical, GitCompare, LayoutDashboard, Lightbulb, ScrollText, Server, Settings, ShieldAlert, Trophy, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/opportunities', label: 'Opportunities', icon: Trophy },
  { href: '/experiments', label: 'Experiments', icon: FlaskConical },
  { href: '/strategies', label: 'Strategies', icon: Beaker },
  { href: '/compare', label: 'Compare', icon: GitCompare },
  { href: '/research', label: 'Research & Ideas', icon: Lightbulb },
  { href: '/portfolio', label: 'Paper Portfolio', icon: Wallet },
  { href: '/performance', label: 'Performance', icon: BarChart3 },
  { href: '/risk', label: 'Risk', icon: ShieldAlert },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/system', label: 'System', icon: Server },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={clsx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium', active ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2 hover:text-text')}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Small screens: the sidebar is hidden, the same links open from a menu button. */
export function MobileNav() {
  return (
    <details className="relative md:hidden">
      <summary className="rounded-md border border-border px-2.5 py-1 text-[13px] font-medium">Menu</summary>
      <div className="absolute left-0 z-30 mt-2 w-56 rounded-lg border border-border bg-surface py-2 shadow-lg">
        <Nav />
      </div>
    </details>
  );
}

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-4 py-4">
      <span className="flex size-7 items-center justify-center rounded-md bg-accent/20 text-accent">
        <Activity className="size-4" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-[13px] font-semibold">Opportunity Center</span>
        <span className="block text-[10.5px] tracking-wider text-muted uppercase">Automated · paper only</span>
      </span>
    </Link>
  );
}

