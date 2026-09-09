import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

// npm workspace commands run in apps/api; load the monorepo environment file.
config({ path: process.env.DOTENV_CONFIG_PATH ?? fileURLToPath(new URL('../../../.env', import.meta.url)) });
