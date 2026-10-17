import { app } from './app.js';
import { env } from './env.js';
import { seed } from './services/demo.js';
import { ensureConstraints } from './db/schema.js';
import { ping, closeFalkorDB } from './db/falkordb.js';

let server: ReturnType<typeof app.listen> | null = null;

async function start() {
  const dbOk = await ping();
  if (!dbOk) {
    console.error(`Cannot reach FalkorDB at ${env.falkordbHost}:${env.falkordbPort}. Start it with: docker compose up -d falkordb`);
    process.exit(1);
  }
  await ensureConstraints();
  if ((process.env.AUTO_SEED ?? 'true') === 'true') {
    await seed();
    console.log('Demo dataset seeded (idempotent).');
  }
  server = app.listen(env.port, () => {
    console.log(`MemoryGuard API listening on http://localhost:${env.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}; shutting down...`);
    if (server) {
      server.close();
      server = null;
    }
    await closeFalkorDB();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
