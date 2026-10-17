import { FalkorDB } from 'falkordb';
import { env } from '../env.js';

/**
 * FalkorDB connection + named graph access.
 * FalkorDB is the persistent source of truth for all graph and containment state.
 */
let client: Awaited<ReturnType<typeof FalkorDB.connect>> | null = null;
let connectPromise: Promise<Awaited<ReturnType<typeof FalkorDB.connect>>> | null = null;

export async function getFalkorDB() {
  if (client) return client;
  if (!connectPromise) {
    connectPromise = FalkorDB.connect({
      socket: {
        host: env.falkordbHost,
        port: env.falkordbPort,
      },
      password: env.falkordbPassword,
    }).then((c) => {
      client = c;
      return c;
    });
  }
  return connectPromise;
}

export async function getGraph(name = process.env.FALKORDB_GRAPH || env.falkordbGraph) {
  const db = await getFalkorDB();
  return db.selectGraph(name);
}

/** Managed Cypher query (write). */
export async function query<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const graph = await getGraph();
  const result = await graph.query(cypher, { params: params as never });
  return ((result.data ?? []) as unknown) as T[];
}

/** Read-only Cypher query. */
export async function roQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const graph = await getGraph();
  const result = await graph.roQuery(cypher, { params: params as never });
  return ((result.data ?? []) as unknown) as T[];
}

export async function ping(): Promise<boolean> {
  try {
    const graph = await getGraph('__ping__');
    await graph.query('RETURN 1');
    return true;
  } catch (err) {
    // A nonexistent graph answers with "empty key" — still proof of connectivity.
    const msg = err instanceof Error ? err.message : String(err);
    return /empty key/i.test(msg);
  }
}

/** Delete the entire demo graph (demo reset only). Tolerates a missing graph. */
export async function dropGraph(name = process.env.FALKORDB_GRAPH || env.falkordbGraph): Promise<void> {
  const db = await getFalkorDB();
  try {
    await db.selectGraph(name).delete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/empty key/i.test(msg)) throw err;
  }
}

export async function closeFalkorDB(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } finally {
      client = null;
      connectPromise = null;
    }
  }
}
