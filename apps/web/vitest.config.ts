import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // @vitejs/plugin-react handles JSX in .tsx test files: the Next.js
  // tsconfig sets "jsx": "preserve", which vite:import-analysis cannot
  // parse (rolldown-vite). The plugin transforms JSX via babel first.
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The web app has no coverage gate yet; keep the report available for the
    // 60% -> 70% ratchet without enforcing it here.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
