import { defineConfig } from '@playwright/test';
// Browser tests share the fixed mock users and the mock fleet's state (connections, fault injection,
// directory changes), so they run on one worker to stay deterministic.
export default defineConfig({testDir:'tests/browser',workers:1,use:{baseURL:'http://127.0.0.1:4200',channel:process.env.PW_CHANNEL},webServer:{command:'npm run dev',url:'http://127.0.0.1:4200',reuseExistingServer:!process.env.CI,timeout:120000}});
