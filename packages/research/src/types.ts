import type { Category, IdeaOrigin, MonitorCategory, SourceType } from '@aoc/core';

/** An idea before it is stored: everything the research database records. */
export interface IdeaDraft {
  name: string;
  category: Category;
  description: string;
  origin: IdeaOrigin;
  estimatedCapital: number | null;
  automationScore: number | null;
  complexityScore: number | null;
  scalabilityScore: number | null;
  testabilityScore: number | null;
  revenueSource: string;
  risks: string[];
  dependencies: string[];
  regulatoryRisks: string[];
  /** Strategy module that can test this idea, if one exists. */
  suggestedStrategyId: string | null;
  /** Parameter or assumption overrides for that module. */
  templateOverrides?: { params?: Record<string, unknown>; assumptions?: Record<string, { low?: number; mode?: number; high?: number }> };
  sources: ResearchItem[];
  notes: string[];
}

export interface ResearchItem {
  sourceType: SourceType;
  title: string;
  url: string;
  author?: string | null;
  repository?: string | null;
  publishedAt?: string | null;
  summary: string;
  relevantConcept?: string;
  advantages?: string[];
  disadvantages?: string[];
  risk?: string;
  implementationIdea?: string;
  license?: string | null;
  termsConcerns?: string;
  github?: {
    stars: number | null;
    forks: number | null;
    openIssues: number | null;
    lastPush: string | null;
    archived: boolean | null;
    language: string | null;
    topics: string[];
  } | null;
  architecture?: string;
  knownLimitations?: string;
  monitorCategory?: MonitorCategory | null;
  relevance?: number | null;
  tags?: string[];
}
