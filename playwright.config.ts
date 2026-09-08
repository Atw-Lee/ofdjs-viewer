import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', use: { baseURL: 'http://127.0.0.1:5173', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }, webServer: { command: 'npm run dev -- --port 5173', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI }, reporter: 'list' });
