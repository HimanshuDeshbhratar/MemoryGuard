import { beforeAll } from 'vitest';
import { FalkorDB } from 'falkordb';

// Tests run against a dedicated throwaway graph so they never pollute the demo data.
process.env.FALKORDB_GRAPH = 'MEMORYGUARD_TEST';
process.env.AUTO_SEED = 'false';
process.env.NODE_ENV = 'test';

export const TEST_GRAPH = 'MEMORYGUARD_TEST';
const testHost = process.env.FALKORDB_HOST ?? '127.0.0.1';
const testPort = Number(process.env.FALKORDB_PORT ?? 6379);

let db: Awaited<ReturnType<typeof FalkorDB.connect>> | null = null;

export async function testDb() {
  if (!db) db = await FalkorDB.connect({ socket: { host: testHost, port: testPort } });
  return db;
}

export async function clearTestGraph() {
  const d = await testDb();
  try {
    await d.selectGraph(TEST_GRAPH).delete();
  } catch {
    // deleting a nonexistent graph is fine during first setup
  }
}
