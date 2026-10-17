import path from 'node:path';

import { createServer } from 'vite';

export default async function globalSetup() {
  const server = await createServer({
    configFile: path.resolve('apps/web/vite.e2e.config.ts'),
    server: { host: '127.0.0.1', port: 4175, strictPort: true },
  });
  await server.listen();
  return async () => server.close();
}
