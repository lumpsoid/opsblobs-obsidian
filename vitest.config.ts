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
  },
});
