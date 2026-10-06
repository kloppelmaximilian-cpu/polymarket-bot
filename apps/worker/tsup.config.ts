import { defineConfig } from 'tsup';

/** Bundle the worker, the CLI and every workspace package into self-contained files for production images. */
export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@aoc\//],
  external: ['@electric-sql/pglite', 'pg', 'pino', 'pino-pretty', 'ws', '@anthropic-ai/sdk'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
