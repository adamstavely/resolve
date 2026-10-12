import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Development settings live in the repository-root .env (see .env.example); real environments set variables directly.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default { poweredByHeader: false, transpilePackages: ["@resolve/contracts", "@resolve/database"] };
