import { defineConfig } from 'vitest/config';
// Database tests run against real PostgreSQL (plan 04). DATABASE_URL must point at a disposable database.
export default defineConfig({test:{include:['tests/**/*.db.test.ts'],fileParallelism:false,testTimeout:20000}});
