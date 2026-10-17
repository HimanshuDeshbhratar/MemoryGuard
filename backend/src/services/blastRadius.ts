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

const DOWNSTREAM_CYPHER = `
MATCH (root:Memory {id: $memoryId})
MATCH path = (root)<-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]-(m:Memory)
WHERE m.id <> root.id
WITH m, min(length(path)) AS depth
ORDER BY depth ASC
LIMIT $maxNodes
RETURN m.id AS memoryId, m.content AS content, m.status AS status, depth
`;

const DOWNSTREAM_COUNT_CYPHER = `
MATCH (root:Memory {id: $memoryId})
MATCH path = (root)<-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]-(m:Memory)
WHERE m.id <> root.id
RETURN count(DISTINCT m) AS downstreamCount
`;

const CHAIN_CYPHER = `
MATCH (root:Memory {id: $mid})
MATCH path = (root)<-[:DERIVED_FROM*0..${TRAVERSAL.maxDepth}]-(m:Memory)<-[:DEPENDS_ON]-(d:Decision)
RETURN d.id AS decisionId, [x IN nodes(path) | x.id] AS chain
LIMIT $maxNodes
`;

const DIRECT_CHAIN_CYPHER_DECISIONS = `
MATCH (d:Decision)-[dep:DEPENDS_ON]->(m:Memory)
WHERE m.id = $mid
  OR (m)-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]->(:Memory {id: $mid})
RETURN DISTINCT d.id AS decisionId, dep.evidence AS evidence
`;

const ROOT_CHAIN_CYPHER = `
MATCH path = (m:Memory {id: $memoryId})<-[:DERIVED_FROM*0..${TRAVERSAL.maxDepth}]-(x)
RETURN [x IN nodes(path) | x.id] AS chain
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

  const decisionRows = await roQuery<{ decisionId: string; evidence: string }>(DIRECT_CHAIN_CYPHER_DECISIONS, {
    mid: suspectMemoryId,
  });
  const dedupDecisions = new Set<string>();
  for (const r of decisionRows) {
    if (!dedupDecisions.has(r.decisionId)) {
      dedupDecisions.add(r.decisionId);
      result.affectedDecisionIds.push(r.decisionId);
    }
  }

    const chainRows = await roQuery<{ chain: string[] }>(CHAIN_CYPHER, { mid: suspectMemoryId, maxNodes: TRAVERSAL.maxNodes });
  const chainSet = new Set<string>();
  for (const row of chainRows as { chain: string[] }[]) {
    const key = row.chain.join('>');
    if (!chainSet.has(key)) {
      chainSet.add(key);
      result.chains.push({ chain: row.chain, decisionId: null });
    }
  }

  void DOWNSTREAM_CYPHER;
  void DOWNSTREAM_COUNT_CYPHER;
  void ROOT_CHAIN_CYPHER;
  return result;
}
