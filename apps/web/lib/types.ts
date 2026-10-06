/**
 * Response types of the API, derived from the platform's own query functions
 * so the dashboard cannot drift from the API. Type-only: nothing from the
 * platform is bundled into the web app.
 */
import type {
  ExperimentListItem,
  KeyResult,
  accountDetail,
  compareExperiments,
  dashboard,
  experimentDetail,
  listDataSources,
  listIdeas,
  listJobs,
  listNotifications,
  listStrategies,
  logs,
  performance,
  portfolio,
  research,
  riskOverview,
  settingsView,
  systemHealth,
  versionComparison,
} from '@aoc/platform';

/** What a value looks like after JSON serialisation (Dates become strings). */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends readonly (infer U)[]
      ? readonly Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : T;

type R<F extends (...args: never[]) => unknown> = Jsonify<Awaited<ReturnType<F>>>;

export type Experiment = Jsonify<ExperimentListItem>;
export type { KeyResult };
export type Dashboard = R<typeof dashboard>;
export type ExperimentDetail = R<typeof experimentDetail>;
export type Compare = R<typeof compareExperiments>;
export type Strategies = R<typeof listStrategies>;
export type Versions = R<typeof versionComparison>;
export type Portfolio = R<typeof portfolio>;
export type AccountDetail = R<typeof accountDetail>;
export type Performance = R<typeof performance>;
export type ResearchSources = R<typeof research>;
export type Ideas = R<typeof listIdeas>;
export type Logs = R<typeof logs>;
export type RiskOverview = R<typeof riskOverview>;
export type Jobs = R<typeof listJobs>;
export type DataSources = R<typeof listDataSources>;
export type Notifications = R<typeof listNotifications>;
export type Settings = R<typeof settingsView>;
export type SystemHealth = R<typeof systemHealth>;

export interface LiveStatus {
  allowed: false;
  reasons: string[];
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
