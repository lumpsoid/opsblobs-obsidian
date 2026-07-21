import { defineConfig } from 'vitest/config';

// Default test run: fast and hermetic. The integration suite (which builds and
// boots the real Go server) is excluded here and run via `npm run test:integration`.
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '__tests__/integration/**',
    ],
    coverage: {
      provider: 'v8',
      // Coverage is a blind-spot finder, not a target — we report the sync-critical
      // modules and don't gate CI on a percentage (see docs/sync-test-coverage-spec.md
      // Part 4). The obsidian-coupled shells (main.ts, ui/*, obsidian-* adapters) are
      // intentionally excluded: they're thin glue verified by manual smoke, and their
      // testable logic already lives in the obsidian-free modules below.
      include: ['src/core/**', 'src/merge/**', 'src/network/**'],
      exclude: ['src/network/obsidian-*.ts', 'src/network/fake-server.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
