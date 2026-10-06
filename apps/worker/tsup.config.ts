import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Production bundle: the workspace packages (@aoc/*) are compiled in; the
 * third-party runtime dependencies stay external (listed in package.json, so
 * `pnpm deploy --prod` installs them). The SQL migrations ship inside dist/.
 */
export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@aoc\//],
  external: ['pino-pretty'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  onSuccess: async () => {
    cpSync('../../packages/database/migrations', 'dist/migrations', { recursive: true });
  },
});
