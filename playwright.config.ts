import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:1420', headless: true, viewport: { width: 1280, height: 840 } },
  webServer: { command: 'npm run dev', url: 'http://localhost:1420', reuseExistingServer: true },
});
