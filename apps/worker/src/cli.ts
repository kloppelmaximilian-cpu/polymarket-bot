import { parseArgs } from 'node:util';
import { describeError, effectiveMode, evaluateLiveGate, newId, redactConfig, silentLogger } from '@aoc/core';
import {
  JOB_NAMES,
  SYSTEM,
  advanceAll,
  advanceExperiment,
  buildJobs,
  dashboard,
  engageEmergencyStop,
  getEmergencyStop,
  listExperiments,
  openRuntime,
  releaseEmergencyStop,
  seed,
  syncDataSources,
  systemHealth,
  type JobName,
  type Runtime,
} from '@aoc/platform';

const HELP = `Automated Opportunity Center — operator CLI (paper / simulation only)

Usage: pnpm aoc <command> [options]

  migrate                         apply database migrations
  seed [--no-start]               create starter experiments, ideas and research sources (idempotent)
  doctor                          check configuration, database, worker, data sources, live gate
  probe                           probe every market data source once
  status                          dashboard summary
  experiments [--status S]        list experiments with score and status
  advance [experimentId]          run one pipeline step (all experiments, or one forced)
  job <name> [--json '{...}']     run one job handler now, in this process
  emergency-stop --reason "..."   EMERGENCY STOP: pause all automated experiments, cancel paper orders
  release --reason "..." [--resume]
                                  release the emergency stop (optionally resume what it paused)

Job names: ${JOB_NAMES.join(', ')}
`;

type Cmd = (rt: Runtime, args: string[], flags: Record<string, string | boolean | undefined>) => Promise<void>;

const print = (s = '') => process.stdout.write(`${s}\n`);
const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? 'NO DATA' : v.toFixed(digits));
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

const commands: Record<string, Cmd> = {
  migrate: async (rt) => {
    await rt.database.migrate();
    print(`migrations applied (${rt.database.kind})`);
  },

  seed: async (rt, _a, flags) => {
    const r = await seed(rt.ctx, { startStarters: !flags['no-start'] });
    print(`strategy modules: ${r.strategies}, research sources: ${r.sources}`);
    print(`created ${r.created.length} experiment(s)${r.created.length ? `: ${r.created.join(', ')}` : ''}`);
    if (r.skipped.length) print(`skipped: ${r.skipped.join(', ')}`);
  },

  doctor: async (rt) => {
    const { config } = rt;
    let problems = 0;
    const line = (ok: boolean | 'warn', label: string, detail: string) => {
      if (ok === false) problems++;
      print(`${ok === true ? '  ok  ' : ok === 'warn' ? ' warn ' : ' FAIL '} ${pad(label, 18)} ${detail}`);
    };
    print('Configuration (secrets redacted):');
    for (const [k, v] of Object.entries(redactConfig(config))) print(`        ${pad(k, 32)} ${String(v)}`);
    print();
    line(true, 'mode', `${effectiveMode(config)} — live trading is not implemented in this build`);
    try {
      line(true, 'database', `${rt.database.kind}, ping ${await rt.database.ping()} ms`);
    } catch (e) {
      line(false, 'database', describeError(e).message);
    }
    const health = await systemHealth(rt.ctx, 'ONLINE');
    // Only the database is a hard requirement here; the rest is reported (a fresh install has no worker or ticks yet).
    for (const c of health.components.filter((x) => x.component !== 'API' && x.component !== 'System' && x.component !== 'Database')) line(c.status === 'ONLINE' ? true : 'warn', c.component, `${c.status} — ${c.detail}`);
    const stop = await getEmergencyStop(rt.ctx.db);
    line(stop.engaged ? 'warn' : true, 'emergency stop', stop.engaged ? `ENGAGED since ${stop.engagedAt}: ${stop.reason}` : 'released');
    const gate = evaluateLiveGate(config, { experimentStatus: 'PAPER', humanApprovalId: null, emergencyStopEngaged: stop.engaged, requestedCapitalUsd: 0 });
    line(true, 'live gate', `closed (${gate.reasons.length} reason(s), e.g. "${gate.reasons.at(-1)}")`);
    line(config.API_TOKEN ? true : 'warn', 'api auth', config.API_TOKEN ? 'bearer token configured' : `no API_TOKEN — API must stay bound to localhost (API_HOST=${config.API_HOST})`);
    line(config.ANTHROPIC_API_KEY && config.IDEA_GENERATOR_LLM_ENABLED ? true : 'warn', 'idea generator', config.ANTHROPIC_API_KEY && config.IDEA_GENERATOR_LLM_ENABLED ? `Claude (${config.LLM_MODEL})` : 'built-in catalogue (set ANTHROPIC_API_KEY and IDEA_GENERATOR_LLM_ENABLED=true for Claude)');
    print();
    print(problems ? `${problems} problem(s) found` : 'no blocking problems');
    if (problems) process.exitCode = 1;
  },

  probe: async (rt) => {
    const res = await rt.ctx.marketData.probe();
    await syncDataSources(rt.ctx);
    for (const [k, v] of Object.entries(res)) print(`${pad(k, 26)} ${v}`);
  },

  status: async (rt) => {
    const d = await dashboard(rt.ctx);
    print(`MODE ${d.mode}   EMERGENCY STOP ${d.riskStatus.emergencyStop.engaged ? 'ENGAGED' : 'off'}   RISK ${d.riskStatus.status}`);
    print(`experiments: ${d.totals.totalExperiments} total, ${d.totals.activeExperiments} active, ${d.totals.failed} failed`);
    print(`paper portfolio (virtual money): equity ${fmt(d.paperPortfolio.equity)} USD, P&L ${fmt(d.paperPortfolio.pnl)} USD, ${d.paperPortfolio.activeAccounts} active account(s)`);
    print(`simulated business operations: P&L ${fmt(d.simulatedBusiness.pnl)} USD (simulated, not observed)`);
    print(`average score: ${fmt(d.averageScore, 1)}   best strategy: ${d.bestStrategy?.name ?? 'NO DATA'}   best business model: ${d.bestBusinessModel?.name ?? 'NO DATA'}`);
    print();
    print('Top opportunities:');
    for (const e of d.topOpportunities) print(`  #${e.score?.rank ?? '-'} ${pad(e.name, 44)} ${pad(e.status, 22)} score ${fmt(e.score?.overall, 1)} (${e.score?.confidence ?? '-'}, ${e.score?.evidence ?? '-'})`);
    if (d.topOpportunities.length === 0) print('  NO DATA — run the pipeline (worker) first');
  },

  experiments: async (rt, _a, flags) => {
    const rows = await listExperiments(rt.ctx, { status: typeof flags.status === 'string' ? flags.status.split(',') : undefined, sort: 'rank' });
    print(`${pad('NAME', 46)} ${pad('STATUS', 22)} ${pad('KIND', 18)} ${pad('SCORE', 8)} RISK`);
    for (const e of rows) print(`${pad(e.name, 46)} ${pad(e.status, 22)} ${pad(e.kind, 18)} ${pad(fmt(e.score?.overall, 1), 8)} ${e.riskLevel}`);
  },

  advance: async (rt, args) => {
    if (args[0]) {
      const s = await advanceExperiment(rt.ctx, args[0], { actor: SYSTEM, force: true });
      print(`${s.from} → ${s.to ?? '(no change)'}: ${s.note}`);
      return;
    }
    const names = new Map((await listExperiments(rt.ctx, { includeArchived: true })).map((e) => [e.id, e.name]));
    for (const s of await advanceAll(rt.ctx)) if (s.to || s.note.startsWith('error')) print(`${pad(names.get(s.experimentId) ?? s.experimentId, 44)} ${s.from} → ${s.to ?? '-'}: ${s.note}`);
  },

  job: async (rt, args, flags) => {
    const name = args[0] as JobName | undefined;
    if (!name || !JOB_NAMES.includes(name)) throw new Error(`job name required, one of: ${JOB_NAMES.join(', ')}`);
    const def = buildJobs(rt.ctx)[name];
    if (def.haltable && (await getEmergencyStop(rt.ctx.db)).engaged) throw new Error(`${name} does not run while the emergency stop is engaged`);
    const payload = typeof flags.json === 'string' ? (JSON.parse(flags.json) as Record<string, unknown>) : {};
    const job = { id: newId(), name, dedupeKey: null, payload, status: 'RUNNING' as const, attempts: 1, maxAttempts: 1, runAt: new Date(), lockedBy: 'cli', lockedUntil: null };
    const result = await def.handler({ job, keepAlive: async () => undefined, log: rt.logger });
    print(JSON.stringify(result ?? {}, null, 2));
  },

  'emergency-stop': async (rt, _a, flags) => {
    if (typeof flags.reason !== 'string' || flags.reason.trim().length < 3) throw new Error('--reason "..." is required');
    const r = await engageEmergencyStop(rt.ctx, flags.reason, { type: 'USER', id: 'cli' });
    print(`EMERGENCY STOP ENGAGED — ${r.paused} experiment(s) paused, ${r.cancelledOrders} open paper order(s) cancelled`);
  },

  release: async (rt, _a, flags) => {
    if (typeof flags.reason !== 'string' || flags.reason.trim().length < 3) throw new Error('--reason "..." is required');
    const r = await releaseEmergencyStop(rt.ctx, flags.reason, { type: 'USER', id: 'cli' }, { resumePaused: !!flags.resume });
    print(`emergency stop released${flags.resume ? `, ${r.resumed} experiment(s) resumed` : ' (paused experiments stay paused; resume them individually)'}`);
  },
};

// `pnpm aoc experiments | head` closes stdout early: that is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { reason: { type: 'string' }, resume: { type: 'boolean' }, status: { type: 'string' }, json: { type: 'string' }, 'no-start': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [name, ...args] = positionals;
  if (!name || values.help || name === 'help') {
    print(HELP);
    return;
  }
  const cmd = commands[name];
  if (!cmd) throw new Error(`unknown command "${name}"\n\n${HELP}`);
  const rt = await openRuntime({ name: 'aoc-cli', migrate: true, logger: name === 'job' || name === 'advance' ? undefined : silentLogger() });
  try {
    await cmd(rt, args, values);
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${describeError(e).message}\n`);
  process.exit(1);
});
