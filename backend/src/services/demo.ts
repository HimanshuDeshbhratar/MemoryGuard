import { dropGraph, query } from '../db/falkordb.js';
import { ensureConstraints } from '../db/schema.js';
import { seedDemo as seedGraph } from './seed.js';

/**
 * demo:seed  -> idempotent MERGE upsert of the synthetic demonstration dataset.
 * demo:reset -> destroys ONLY the demo graph (dropGraph) and reseeds it.
 * The reset requires confirm phrase in the route layer and is gated by
 * ALLOW_DEMO_RESET; it never exposes arbitrary Cypher.
 */
export async function seed(): Promise<void> {
  await ensureConstraints();
  await seedGraph();
}

export async function reset(): Promise<void> {
  await dropGraph();
  // Recreate the empty graph so index creation works again.
  await query('MERGE (n:ResetMarker {id:0}) DELETE n');
  await ensureConstraints();
  await seedGraph();
}
