import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/browser',use:{baseURL:'http://127.0.0.1:4200',channel:process.env.PW_CHANNEL},webServer:{command:'npm run dev',url:'http://127.0.0.1:4200',reuseExistingServer:!process.env.CI,timeout:120000}});
