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
/**
 * Honest description of what the traversal could and could not establish.
 * A graph can only traverse relationships that were recorded: absence of a
 * recorded path is never proof that no influence exists.
 */
export interface ProvenanceSummary {
  /** Number of explicit DERIVED_FROM edges in the graph (confirmed lineage). */
  declaredRelationshipCount: number;
  /** Number of observed EXPOSED_TO edges in the graph (potential influence). */
  exposureRelationshipCount: number;
  /** Memories in the graph that carry no recorded provenance at all. */
  unprovenancedMemories: number;
  /**
   * True only when every memory has some recorded provenance (declared lineage
   * or a recorded retrieval context). Otherwise the blast radius may be
   * incomplete.
   */
  coverageComplete: boolean;
  caveat: string;
}
export interface BlastRadius {
  incidentId: string;
  suspectMemoryId: string | null;
  /** Confirmed recorded lineage: memories with an explicit DERIVED_FROM path to the suspect. */
  downstreamMemoryIds: string[];
  /** Confirmed recorded lineage: decisions that DEPENDS_ON a memory derived from the suspect. */
  affectedDecisionIds: string[];
  /**
   * Observed exposure (unproven): memories written in a retrieval context that
   * had retrieved the suspect memory (or an already-exposed memory).
   */
  exposedMemoryIds: string[];
  /** Observed exposure (unproven): decisions written in / depending on an exposed record. */
  exposedDecisionIds: string[];
  /** Retrieval contexts that contributed exposure paths. */
  exposureContextIds: string[];
  memoryDepth: Record<string, number>;
  chains: { chain: string[]; decisionId: string | null }[];
  truncated: boolean;
  /** Completeness / coverage caveats for the blast radius. */
  provenance: ProvenanceSummary;
}

const PROVENANCE_CAVEAT =
  'Blast radius is computed only from recorded relationships. Absence of a path is not evidence of absence of influence: memories absorbed without declared lineage and retrievals never recorded cannot be discovered.';

async function computeProvenanceSummary(): Promise<ProvenanceSummary> {
  const [declared, exposure, unprovenanced] = await Promise.all([
    roQuery<{ n: number }>('MATCH ()-[e:DERIVED_FROM]->() RETURN count(e) AS n'),
    roQuery<{ n: number }>('MATCH ()-[e:EXPOSED_TO]->() RETURN count(e) AS n'),
    roQuery<{ n: number }>(
      `MATCH (m:Memory)
       OPTIONAL MATCH (m)-[:DERIVED_FROM]->(p:Memory)
       OPTIONAL MATCH (m)<-[:DERIVED_FROM]-(c:Memory)
       OPTIONAL MATCH (m)-[:CREATED_IN]->(ctx:Context)
       WITH m, collect(DISTINCT p) AS ps, collect(DISTINCT c) AS cs, collect(DISTINCT ctx) AS ctxs
       WITH m,
            [x IN ps WHERE x IS NOT NULL] AS ps2,
            [x IN cs WHERE x IS NOT NULL] AS cs2,
            [x IN ctxs WHERE x IS NOT NULL] AS ctxs2
       WHERE size(ps2) = 0 AND size(cs2) = 0 AND size(ctxs2) = 0
       RETURN count(m) AS n`,
    ),
  ]);
  const unprovenancedMemories = Number(unprovenanced[0]?.n) || 0;
  return {
    declaredRelationshipCount: Number(declared[0]?.n) || 0,
    exposureRelationshipCount: Number(exposure[0]?.n) || 0,
    unprovenancedMemories,
    coverageComplete: unprovenancedMemories === 0,
    caveat: PROVENANCE_CAVEAT,
  };
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
    exposedMemoryIds: [],
    exposedDecisionIds: [],
    exposureContextIds: [],
    memoryDepth: {},
    chains: [],
    truncated: false,
    provenance: {
      declaredRelationshipCount: 0,
      exposureRelationshipCount: 0,
      unprovenancedMemories: 0,
      coverageComplete: false,
      caveat: PROVENANCE_CAVEAT,
    },
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

  // 4. Observed exposure (unproven). Records written in a retrieval context that
  //    had retrieved the suspect memory (or a transitively exposed memory).
  const exposedMemoryRows = await roQuery<{ memoryId: string; depth: number }>(
    `MATCH path = (m:Memory)-[:EXPOSED_TO*1..${TRAVERSAL.maxDepth}]->(root:Memory {id:$mid})
     WHERE m.id <> root.id
     WITH m, min(length(path)) AS depth
     ORDER BY depth ASC
     LIMIT ${TRAVERSAL.maxNodes}
     RETURN m.id AS memoryId, depth`,
    { mid: suspectMemoryId },
  );
  const exposedSet = new Set<string>();
  for (const r of exposedMemoryRows) {
    if (!exposedSet.has(r.memoryId)) {
      exposedSet.add(r.memoryId);
      result.exposedMemoryIds.push(r.memoryId);
    }
  }
  if (exposedMemoryRows.length >= maxNodes) result.truncated = true;

  const exposedDecisionRows = await roQuery<{ decisionId: string }>(
    `MATCH (root:Memory {id:$mid})
     MATCH (d:Decision)-[:EXPOSED_TO*1..${TRAVERSAL.maxDepth}]->(root)
     RETURN DISTINCT d.id AS decisionId`,
    { mid: suspectMemoryId },
  );
  const exposedDecisionDepRows = await roQuery<{ decisionId: string }>(
    `MATCH (root:Memory {id:$mid})
     MATCH (d:Decision)-[:DEPENDS_ON]->(m:Memory)
     WHERE m.id = root.id OR (m)-[:EXPOSED_TO*1..${TRAVERSAL.maxDepth}]->(root)
     RETURN DISTINCT d.id AS decisionId`,
    { mid: suspectMemoryId },
  );
  const exposedDecisionSet = new Set<string>();
  const declaredDecisionSet = new Set(result.affectedDecisionIds);
  for (const r of [...exposedDecisionRows, ...exposedDecisionDepRows]) {
    // Declared-lineage decisions are reported in affectedDecisionIds only, to
    // keep the two categories independently queryable and non-overlapping.
    if (!declaredDecisionSet.has(r.decisionId) && !exposedDecisionSet.has(r.decisionId)) {
      exposedDecisionSet.add(r.decisionId);
      result.exposedDecisionIds.push(r.decisionId);
    }
  }

  const exposureContextRows = await roQuery<{ contextId: string }>(
    `MATCH (ctx:Context)-[:RETRIEVED]->(m:Memory)
     WHERE m.id = $mid OR (m)-[:EXPOSED_TO*1..${TRAVERSAL.maxDepth}]->(:Memory {id:$mid})
     RETURN DISTINCT ctx.id AS contextId ORDER BY ctx.id`,
    { mid: suspectMemoryId },
  );
  result.exposureContextIds = exposureContextRows.map((r) => r.contextId);

  // 5. Honest provenance coverage.
  result.provenance = await computeProvenanceSummary();

  return result;
}
