import { roQuery } from '../db/falkordb.js';
import { TRAVERSAL } from '../lib/types.js';

export interface BlastRadiusMemory {
  memoryId: string;
  content: string;
  agentId: string | null;
  status: string;
  depth: number;
  chains: string[][];
}
export interface BlastRadius {
  incidentId: string;
  suspectMemoryId: string | null;
  downstreamMemoryIds: string[];
  affectedDecisionIds: string[];
  memoryDepth: Record<string, number>;
  chains: { chain: string[]; decisionId: string | null }[];
  truncated: boolean;
}

/**
 * Finds decisions affected by the suspect memory.
 * A decision is affected if it DEPENDS_ON:
 *   - the suspect root directly, OR
 *   - any memory that is derived (via DERIVED_FROM*) FROM the suspect root.
 *
 * Direction note: DERIVED_FROM edges point FROM child TO parent.
 *   child -[:DERIVED_FROM]-> parent
 * So "derived from root" means: (derived)<-[:DERIVED_FROM*]-(root)?
 * No — DERIVED_FROM is child→parent. "Downstream" means the child IS derived from root,
 * i.e., child-[:DERIVED_FROM*]->root. The child is what we want to catch.
 *
 * Correct Cypher: find (d:Decision)-[:DEPENDS_ON]->(m:Memory) where m is either
 *   - the suspect root itself, or
 *   - a memory that transitively derives from the root (m)-[:DERIVED_FROM*1..N]->(root)
 */
const AFFECTED_DECISIONS_CYPHER = `
MATCH (root:Memory {id: $mid})
MATCH (d:Decision)-[:DEPENDS_ON]->(m:Memory)
WHERE m.id = root.id
   OR (m)-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]->(root)
RETURN DISTINCT d.id AS decisionId
`;

/**
 * Chain query: returns complete memory+decision chains starting from root.
 * Each row: chain = [rootId, ...intermediateMemoryIds, consumerDecisionId]
 * `nodes(path)` includes both matched endpoints, so the final Decision is
 * already present and must not be appended again.
 */
const CHAIN_CYPHER = `
MATCH (root:Memory {id: $mid})
MATCH path = (root)<-[:DERIVED_FROM*0..${TRAVERSAL.maxDepth}]-(m:Memory)<-[:DEPENDS_ON]-(d:Decision)
RETURN d.id AS decisionId, [x IN nodes(path) | x.id] AS chain
LIMIT $maxNodes
`;

/** Compute the bounded blast radius (affected downstream memories and decisions). */
export async function computeBlastRadius(incidentId?: string, memoryId?: string): Promise<BlastRadius> {
  let suspectMemoryId = memoryId ?? null;

  if (incidentId && !suspectMemoryId) {
    const rows = await roQuery<{ memoryId: string | null }>(
      'MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory) RETURN m.id AS memoryId',
      { iid: incidentId },
    );
    suspectMemoryId = rows[0]?.memoryId ?? null;
  }

  const result: BlastRadius = {
    incidentId: incidentId ?? '',
    suspectMemoryId,
    downstreamMemoryIds: [],
    affectedDecisionIds: [],
    memoryDepth: {},
    chains: [],
    truncated: false,
  };

  if (!suspectMemoryId) return result;

  // 1. Find downstream derived memories (children derive FROM the root).
  const memoryRows = await roQuery<{
    memoryId: string;
    content: string;
    status: string;
    agentId: string | null;
    depth: number;
  }>(
    `MATCH path = (root:Memory {id:$mid})<-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]-(m:Memory)
     WHERE m.id <> root.id
     OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
     WITH m, a, min(length(path)) AS depth
     ORDER BY depth ASC
     LIMIT ${TRAVERSAL.maxNodes}
     RETURN m.id AS memoryId, m.content AS content, m.status AS status, a.id AS agentId, depth`,
    { mid: suspectMemoryId },
  );

  const maxNodes = TRAVERSAL.maxNodes;
  const truncated = memoryRows.length >= maxNodes;

  const seen = new Set<string>();
  for (const r of memoryRows) {
    if (!seen.has(r.memoryId)) {
      seen.add(r.memoryId);
      result.memoryDepth[r.memoryId] = r.depth;
      result.downstreamMemoryIds.push(r.memoryId);
    }
  }
  result.truncated = truncated;

  // 2. Find affected decisions via the corrected traversal direction.
  const decisionRows = await roQuery<{ decisionId: string }>(AFFECTED_DECISIONS_CYPHER, {
    mid: suspectMemoryId,
  });
  const dedupDecisions = new Set<string>();
  for (const r of decisionRows) {
    if (!dedupDecisions.has(r.decisionId)) {
      dedupDecisions.add(r.decisionId);
      result.affectedDecisionIds.push(r.decisionId);
    }
  }

  // 3. Collect full chains with the real decisionId populated.
  const chainRows = await roQuery<{ chain: string[]; decisionId: string }>(CHAIN_CYPHER, {
    mid: suspectMemoryId,
    maxNodes: TRAVERSAL.maxNodes,
  });
  const chainSet = new Set<string>();
  for (const row of chainRows) {
    const key = row.chain.join('>');
    if (!chainSet.has(key)) {
      chainSet.add(key);
      result.chains.push({ chain: row.chain, decisionId: row.decisionId ?? null });
    }
  }

  return result;
}
