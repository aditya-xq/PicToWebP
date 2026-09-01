import { defineConfig, devices } from '@playwright/test';

/**
 * Python-backend e2e: serves the unified SPA from the local FastAPI server
 * (requires `npm run build:python` first — the spec asserts the python
 * edition, so a stale static build would fail loudly).
 */
export default defineConfig({
  testDir: './e2e-python',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Served from the repo root so the installed `pictowebp` package resolves.
    command: 'uv run uvicorn pictowebp.web.app:app --host 127.0.0.1 --port 8000',
    url: 'http://127.0.0.1:8000',
    cwd: '..',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});