import { roQuery, query } from '../db/falkordb.js';
import { newId, nowIso, toJsonProp } from '../lib/types.js';
import { evaluateNewMemory } from './detection.js';

export interface MemoryRecord {
  id: string;
  content: string;
  status: string;
  trust: string;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  sourceRef: string;
  sourceTrusted: boolean;
  reason: string;
  agentId: string | null;
  incidents: string[];
}

const LIST_QUERY = `
MATCH (m:Memory)
OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
OPTIONAL MATCH (m)-[:SUPPORTED_BY]->(s:Source)
OPTIONAL MATCH (i:Incident)-[:TARGETS]->(m)
WITH m, a, s, collect(DISTINCT i.id) AS incidentIds
WHERE ($search IS NULL OR toLower(m.content) CONTAINS toLower($search))
  AND ($status IS NULL OR m.status = $status)
  AND ($agentId IS NULL OR a.id = $agentId)
RETURN m.id AS id, m.content AS content, m.status AS status, m.trust AS trust,
       m.createdAt AS createdAt, m.updatedAt AS updatedAt,
       coalesce(m.sourceType,'') AS sourceType, coalesce(s.id,'') AS sourceRef,
       coalesce(s.trusted,true) AS sourceTrusted, coalesce(m.reason,'') AS reason,
       a.id AS agentId, incidentIds
ORDER BY m.createdAt DESC
SKIP $skip
LIMIT $limit`;

export async function listMemories(opts: {
  search?: string;
  status?: string;
  agentId?: string;
  limit: number;
  offset: number;
}): Promise<{ items: MemoryRecord[]; total: number }> {
  const params: Record<string, unknown> = {
    search: opts.search ?? null,
    status: opts.status ?? null,
    agentId: opts.agentId ?? null,
    limit: opts.limit,
    skip: opts.offset,
  };
  const items = await roQuery<MemoryRecord>(LIST_QUERY, params);
  const totalRows = await roQuery<{ n: number }>(
    `MATCH (m:Memory)
     OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
     WHERE ($search IS NULL OR toLower(m.content) CONTAINS toLower($search))
       AND ($status IS NULL OR m.status = $status)
       AND ($agentId IS NULL OR a.id = $agentId)
     RETURN count(DISTINCT m) AS n`,
    params,
  );
  return { items: items.filter((r) => r.id), total: Number(totalRows[0]?.n) || 0 };
}

export interface MemoryProvenance {
  memory: MemoryRecord;
  derivedFrom: Array<{ id: string; content: string; status: string }>;
  derivedMemories: Array<{ id: string; content: string; status: string }>;
  supportingSources: Array<{ id: string; type: string; description: string; trusted: boolean }>;
  dependentDecisions: Array<{ id: string; description: string; status: string }>;
  createdAtBy: { id: string; name: string; role: string } | null;
  auditTrail: { id: string; type: string; reason: string; createdAt: string }[];
}

interface RelatedMemory {
  id: string;
  content: string;
  status: string;
}

const PROVENANCE_BLOCK = `
MATCH (m:Memory {id:$id})
OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
OPTIONAL MATCH (m)-[:SUPPORTED_BY]->(s:Source)
OPTIONAL MATCH (m)-[:DERIVED_FROM]->(parent:Memory)
WITH m, a, s, collect(DISTINCT parent.id) AS derivedFrom
OPTIONAL MATCH (child:Memory)-[:DERIVED_FROM]->(m)
WITH m, a, s, derivedFrom, collect(DISTINCT child.id) AS derivedMemories
OPTIONAL MATCH (d:Decision)-[:DEPENDS_ON]->(m)
WITH m, a, s, derivedFrom, derivedMemories, collect(DISTINCT d.id) AS dependentDecisions
OPTIONAL MATCH (i:Incident)-[:TARGETS]->(m)
RETURN m.id AS id, m.content AS content, m.status AS status, m.trust AS trust,
       m.createdAt AS createdAt, m.updatedAt AS updatedAt,
       coalesce(m.sourceType,'') AS sourceType, coalesce(s.id,'') AS sourceRef,
       coalesce(s.trusted,true) AS sourceTrusted, coalesce(m.reason,'') AS reason,
       a.id AS agentId, collect(DISTINCT i.id) AS incidents,
       derivedFrom, derivedMemories, dependentDecisions,
       s.id AS sid, s.type AS stype, s.description AS sdesc, s.trusted AS strusted`;

export async function getMemoryWithProvenance(id: string): Promise<MemoryProvenance | null> {
  const rows = await roQuery<
    MemoryRecord & {
      derivedFrom: string[];
      derivedMemories: string[];
      dependentDecisions: string[];
      sid: string | null;
      stype: string | null;
      sdesc: string | null;
      strusted: boolean | null;
    }
  >(PROVENANCE_BLOCK, { id });
  if (!rows.length) return null;
  const r = rows[0];
  const memory: MemoryRecord = {
    id: r.id,
    content: r.content,
    status: r.status,
    trust: r.trust,
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt),
    sourceType: r.sourceType,
    sourceRef: r.sourceRef,
    sourceTrusted: Boolean(r.sourceTrusted),
    reason: r.reason,
    agentId: r.agentId,
    incidents: r.incidents ?? [],
  };

  // Rich lineage detail for the Memory Explorer drill-down: contents + status of
  // every related record, so the UI renders human-readable lineage from one call.
  const clean = (list: unknown[]): RelatedMemory[] =>
    (list as RelatedMemory[]).filter((x) => x && x.id);
  const [parents, children, sources, decisions, agents] = await Promise.all([
    roQuery<RelatedMemory>(
      `MATCH (m:Memory {id:$id})-[:DERIVED_FROM]->(p:Memory)
       RETURN p.id AS id, p.content AS content, p.status AS status ORDER BY p.createdAt`,
      { id },
    ),
    roQuery<RelatedMemory>(
      `MATCH (m:Memory {id:$id})<-[:DERIVED_FROM]-(c:Memory)
       RETURN c.id AS id, c.content AS content, c.status AS status ORDER BY c.createdAt`,
      { id },
    ),
    roQuery<{ id: string; type: string; description: string; trusted: boolean }>(
      `MATCH (m:Memory {id:$id})-[:SUPPORTED_BY]->(s:Source)
       RETURN s.id AS id, s.type AS type, s.description AS description, s.trusted AS trusted`,
      { id },
    ),
    roQuery<{ id: string; description: string; status: string }>(
      `MATCH (d:Decision)-[:DEPENDS_ON]->(m:Memory {id:$id})
       RETURN d.id AS id, d.description AS description, d.status AS status ORDER BY d.createdAt`,
      { id },
    ),
    roQuery<{ id: string; name: string; role: string }>(
      `MATCH (a:Agent)-[:CREATED]->(m:Memory {id:$id}) RETURN a.id AS id, a.name AS name, a.role AS role`,
      { id },
    ),
  ]);
  const agent = agents[0] ?? null;

  return {
    memory,
    derivedFrom: clean(parents),
    derivedMemories: clean(children),
    supportingSources: sources.filter((s) => s.id),
    dependentDecisions: decisions.filter((d) => d.id),
    createdAtBy: agent,
    auditTrail: [],
  };
}

export interface CreateMemoryInput {
  content: string;
  agentId: string;
  sourceType: string;
  sourceRef?: string;
  sourceTrusted: boolean;
  derivedFrom?: string;
}

export async function createMemory(input: CreateMemoryInput): Promise<{
  memoryId: string;
  incidentId: string | null;
}> {
  const memoryId = newId('mem');
  const ts = nowIso();
  const sourceId = newId('src');
  const trust = input.sourceTrusted ? 'trusted' : 'untrusted';
  const status = 'trusted'; // status transitions run only through the backend pipeline

  await query(
    `MATCH (a:Agent {id:$agentId})
     MERGE (s:Source {id:$sid})
       ON CREATE SET s.type=$stype, s.description=$sdesc, s.trusted=$strusted, s.createdAt=$ts, s.synthetic=true
     CREATE (m:Memory {
       id:$mid, content:$content, status:$status, trust:$trust,
       createdAt:$ts, updatedAt:$ts, sourceType:$stype, sourceRef:$sref, reason:'' , synthetic:true
     })
     MERGE (a)-[:CREATED]->(m)
     MERGE (m)-[:SUPPORTED_BY]->(s)`,
    {
      agentId: input.agentId,
      sid: sourceId,
      stype: input.sourceType,
      sdesc: input.sourceRef ?? '',
      strusted: input.sourceTrusted,
      mid: memoryId,
      content: input.content,
      status,
      trust,
      ts,
      sref: input.sourceRef ?? '',
    },
  );

  if (input.derivedFrom) {
    await query(
      `MATCH (child:Memory {id:$cid}), (parent:Memory {id:$pid})
       MERGE (child)-[d:DERIVED_FROM]->(parent)
         SET d.evidence=$ev`,
      { cid: memoryId, pid: input.derivedFrom, ev: toJsonProp([{ kind: 'derivation', note: 'Created referencing parent memory' }]) },
    );
  }

  const result = await evaluateNewMemory({
    memoryId,
    content: input.content,
    sourceType: input.sourceType,
    sourceTrusted: input.sourceTrusted,
  });

  if (result.incidentId) {
    await query(`MATCH (m:Memory {id:$mid}) SET m.status='suspicious', m.reason=$reason`, {
      mid: memoryId,
      reason: result.evaluation.evidenceNote,
    });
  }

  return { memoryId, incidentId: result.incidentId };
}

export async function listAgents(): Promise<{ id: string; name: string; role: string; status: string; memoryCount: number }[]> {
  const rows = await roQuery<{ id: string; name: string; role: string; status: string; memoryCount: number }>(
    `MATCH (a:Agent)
     OPTIONAL MATCH (a)-[:CREATED]->(m:Memory)
     RETURN a.id AS id, a.name AS name, a.role AS role, a.status AS status, count(DISTINCT m) AS memoryCount
     ORDER BY a.id`,
  );
  return rows.map((r) => ({ ...r, memoryCount: Number(r.memoryCount) || 0 }));
}
