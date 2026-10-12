import { defineConfig } from 'vitest/config';
// Contract tests against a Quackback fork checkout (QUACKBACK_SRC); see plan 04.
export default defineConfig({test:{include:['tests/**/*.contract.test.ts']}});
