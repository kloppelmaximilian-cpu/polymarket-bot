import { NotFoundError, ValidationError, type StrategyKind } from '@aoc/core';
import type { AnyStrategyModule } from './types';

/** All strategy and business modules known to this build. */
export class StrategyRegistry {
  private readonly modules = new Map<string, AnyStrategyModule>();

  register(module: AnyStrategyModule): this {
    const id = module.meta.id;
    if (!/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(id)) throw new ValidationError(`invalid strategy id "${id}" (expected "<group>.<name>")`);
    if (this.modules.has(id)) throw new ValidationError(`strategy "${id}" registered twice`);
    // Fail at startup, not mid-pipeline, if defaults do not satisfy the schema.
    const parsed = module.meta.paramsSchema.safeParse(module.meta.defaultParams);
    if (!parsed.success) throw new ValidationError(`strategy "${id}": default params do not match its schema: ${parsed.error.message}`);
    this.modules.set(id, module);
    return this;
  }

  get(id: string): AnyStrategyModule {
    const m = this.modules.get(id);
    if (!m) throw new NotFoundError('strategy', id);
    return m;
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  list(kind?: StrategyKind): AnyStrategyModule[] {
    const all = [...this.modules.values()];
    return kind ? all.filter((m) => m.meta.kind === kind) : all;
  }

  /** Validate (and default) parameters for a module. */
  parseParams(id: string, params: unknown): Record<string, unknown> {
    const m = this.get(id);
    const merged = { ...(m.meta.defaultParams as Record<string, unknown>), ...((params as Record<string, unknown>) ?? {}) };
    const parsed = m.meta.paramsSchema.safeParse(merged);
    if (!parsed.success) throw new ValidationError(`invalid parameters for ${id}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return parsed.data as Record<string, unknown>;
  }
}
