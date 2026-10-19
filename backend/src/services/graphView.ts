import { roQuery } from '../db/falkordb.js';

export type GraphNodeType = 'Agent' | 'Memory' | 'Source' | 'Decision' | 'Incident' | 'AuditEvent';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status: string;
  trust?: string;
  meta: Record<string, unknown>;
  incidentSuspect: boolean;
  onIncidentPath: boolean;
  flagged: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  flagged: boolean;
}

export interface GraphQuery {
  agentId?: string;
  status?: string;
  type?: GraphNodeType | 'all';
  incidentId?: string;
}

interface NodeRow {
  id: string;
  type: string;
  name: string;
  content: string;
  status: string;
  trust: string;
  severity: string;
  role: string;
  sourceType: string;
  description: string;
}

interface EdgeRow {
  sourceType: string;
  sourceId: string;
  targetId: string;
  relType: string;
}

const EDGE_QUERY = `
MATCH (a)-[r]->(b)
RETURN labels(a)[0] AS sourceType, a.id AS sourceId,
       labels(b)[0] AS targetType, b.id AS targetId,
       type(r) AS relType
LIMIT $limit
`;

const NODE_QUERY = `
MATCH (n)
WHERE labels(n)[0] IN ['Agent','Memory','Source','Decision','Incident']
RETURN labels(n)[0] AS type, n.id AS id,
       coalesce(n.name, n.description, '[' + left(n.content, 60) + '…]') AS name,
       coalesce(n.status, '') AS status,
       coalesce(n.trust, '') AS trust,
       coalesce(n.severity, '') AS severity,
       coalesce(n.role, '') AS role,
       coalesce(n.sourceType, '') AS sourceType,
       n.content AS content
LIMIT $limit
`;

const FLAGGED_QUERY = `
MATCH (x)-[:FLAGGED_BY]->(i:Incident)
RETURN labels(x)[0] AS type, x.id AS id
`;

/**
 * Defensive upper bound for the whole-graph view. The demo dataset is far
 * smaller; this only guards against unexpectedly large graphs.
 */
const GRAPH_LIMIT = 1000;

/** Returns the true graph structure. No edges are invented here. */
export async function graphView(
  q: GraphQuery,
): Promise<{ incidentId: string | null; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const [nodeRows, edgeRows, flaggedRows] = await Promise.all([
    roQuery<NodeRow>(NODE_QUERY, { limit: GRAPH_LIMIT }),
    roQuery<EdgeRow>(EDGE_QUERY, { limit: GRAPH_LIMIT }),
    roQuery<{ id: string }>(FLAGGED_QUERY, {}),
  ]);

  const truncated = nodeRows.length >= GRAPH_LIMIT || edgeRows.length >= GRAPH_LIMIT;

  const flagged = new Set(flaggedRows.map((r) => r.id));

  // Suspect memory + its downstream path members for highlight.
  const pathMembers = new Set<string>();
  const suspectIds = new Set<string>();
  if (q.incidentId) {
    const suspectRows = await roQuery<{ mid: string }>(
      'MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory) RETURN m.id AS mid',
      { iid: q.incidentId },
    );
    for (const r of suspectRows) {
      suspectIds.add(r.mid);
      pathMembers.add(r.mid);
      const downstream = await roQuery<{ mid: string }>(
        `MATCH (root:Memory {id:$mid})<-[:DERIVED_FROM*1..6]-(x:Memory) RETURN DISTINCT x.id AS mid`,
        { mid: r.mid },
      );
      for (const d of downstream) pathMembers.add(d.mid);
      const decisions = await roQuery<{ did: string }>(
        `MATCH (d:Decision)-[:DEPENDS_ON*1..6]->(:Memory {id:$mid}) RETURN DISTINCT d.id AS did`,
        { mid: r.mid },
      );
      for (const d of decisions) pathMembers.add(d.did);
      // Observed-exposure downstream: records written in a context that retrieved
      // the suspect (or a transitively exposed memory). Highlight only.
      const exposedMemories = await roQuery<{ mid: string }>(
        `MATCH (x:Memory)-[:EXPOSED_TO*1..6]->(:Memory {id:$mid}) RETURN DISTINCT x.id AS mid`,
        { mid: r.mid },
      );
      for (const d of exposedMemories) pathMembers.add(d.mid);
      const exposedDecisions = await roQuery<{ did: string }>(
        `MATCH (d:Decision)-[:EXPOSED_TO*1..6]->(:Memory {id:$mid}) RETURN DISTINCT d.id AS did`,
        { mid: r.mid },
      );
      for (const d of exposedDecisions) pathMembers.add(d.did);
    }
  }

  const agentsInvolved = new Set<string>();
  if (q.incidentId) {
    const agentRows = await roQuery<{ aid: string }>(
      `MATCH (a:Agent)-[:CREATED]->(m:Memory)
       WHERE (m)<-[:TARGETS]-(:Incident {id:$iid})
          OR (m)-[:DERIVED_FROM*1..6]->(:Memory)<-[:TARGETS]-(:Incident {id:$iid})
          OR (m)<-[:DERIVED_FROM*1..6]-(:Memory)<-[:TARGETS]-(:Incident {id:$iid})
          OR (m)<-[:DEPENDS_ON]-(:Decision)<-[:AFFECTS]-(:Incident {id:$iid})
          OR (m)-[:EXPOSED_TO*1..6]->(:Memory)<-[:TARGETS]-(:Incident {id:$iid})
       RETURN DISTINCT a.id AS aid`,
      { iid: q.incidentId },
    );
    for (const r of agentRows) agentsInvolved.add(r.aid);
  }

  let nodes: GraphNode[] = nodeRows
    .filter((r): r is NodeRow & { id: string } => Boolean(r.id))
    .map((r) => ({
      id: r.id,
      type: r.type as GraphNodeType,
      label: r.name ?? r.id,
      status: r.status ?? '',
      trust: r.trust || undefined,
      meta: {
        content: r.content || undefined,
        severity: r.severity || undefined,
        role: r.role || undefined,
        sourceType: r.sourceType || undefined,
      },
      incidentSuspect: suspectIds.has(r.id),
      onIncidentPath: pathMembers.has(r.id) || agentsInvolved.has(r.id),
      flagged: flagged.has(r.id),
    }));

  let edges: GraphEdge[] = edgeRows
    .filter((r): r is EdgeRow & { sourceId: string; targetId: string } => Boolean(r.sourceId) && Boolean(r.targetId))
    .map((r) => ({
      id: `${r.sourceId}->${r.relType}->${r.targetId}`,
      source: r.sourceId,
      target: r.targetId,
      type: r.relType,
      flagged: flagged.has(r.sourceId) && flagged.has(r.targetId),
    }));

  // Filters.
  if (q.type && q.type !== 'all') {
    nodes = nodes.filter((n) => n.type === q.type);
  }
  if (q.status) {
    nodes = nodes.filter((n) => n.status === q.status || n.trust === q.status);
  }
  if (q.agentId) {
    const keep = new Set<string>([q.agentId]);
    // local-neighbourhood of the agent: its created memories/decisions + their direct relationships.
    for (const e of edges) {
      const source = nodes.find((n) => n.id === e.source && e.source === q.agentId);
      if (source) keep.add(e.target);
      const target = nodes.find((n) => n.id === e.target && e.target === q.agentId);
      if (target) keep.add(e.source);
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }
  // Drop edges referencing filtered-out nodes.
  const nodeIds = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { incidentId: q.incidentId ?? null, nodes, edges, truncated };
}
