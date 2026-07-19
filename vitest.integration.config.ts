import { defineConfig } from 'vitest/config';

// Integration run: only the client↔server suite, which builds + boots the real
// Go server (SYNC_SERVER_DIR, default ../obsidian-sync-golang). Longer timeouts
// cover the one-time `go build` and server startup.
export default defineConfig({
  test: {
    include: ['__tests__/integration/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // The suite starts a single shared server; keep files serialised so runs
    // are simple and the process lifecycle is unambiguous.
    fileParallelism: false,
  },
});
