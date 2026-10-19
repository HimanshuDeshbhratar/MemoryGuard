import { roQuery, query } from '../db/falkordb.js';
import { newId, nowIso, toJsonProp } from '../lib/types.js';
import { ValidationError } from '../lib/errors.js';
import { assertContextOwnership, linkRecordToContext } from './contexts.js';
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
  /**
   * Observed exposure: memories that were recorded as retrieved in a context
   * this memory was written in. This is potential influence only — it is *not*
   * declared derivation and does not prove causality.
   */
  exposedTo: Array<{ id: string; content: string; status: string; contextId: string }>;
  /**
   * Records written in a context that retrieved this memory. These are the
   * records potentially influenced by this memory through observed exposure.
   */
  exposedRecords: Array<{ id: string; label: string; kind: 'memory' | 'decision'; contextId: string }>;
  /** Retrieval contexts this memory was declared to be written in (empty when unknown). */
  createdInContexts: string[];
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
  const [parents, children, sources, decisions, agents, exposedTo, exposedMemories, exposedDecisions, contexts] = await Promise.all([
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
      `MATCH (d:Decision)-[:DEPENDS_ON]->(dependency:Memory)
       MATCH (dependency)-[:DERIVED_FROM*0..6]->(root:Memory {id:$id})
       RETURN DISTINCT d.id AS id,
              d.description AS description,
              d.status AS status
       ORDER BY id`,
      { id },
    ),
    roQuery<{ id: string; name: string; role: string }>(
      `MATCH (a:Agent)-[:CREATED]->(m:Memory {id:$id}) RETURN a.id AS id, a.name AS name, a.role AS role`,
      { id },
    ),
    // Observed exposure (unproven): memories this record was exposed to.
    roQuery<{ id: string; content: string; status: string; contextId: string }>(
      `MATCH (m:Memory {id:$id})-[e:EXPOSED_TO]->(src:Memory)
       RETURN src.id AS id, src.content AS content, src.status AS status,
              coalesce(e.contextId,'') AS contextId
       ORDER BY src.id`,
      { id },
    ),
    // Records written in a context that retrieved this memory (memories).
    roQuery<{ id: string; label: string; contextId: string }>(
      `MATCH (m:Memory {id:$id})<-[:RETRIEVED]-(ctx:Context)<-[:CREATED_IN]-(r:Memory)
       RETURN DISTINCT r.id AS id, r.content AS label, ctx.id AS contextId
       ORDER BY r.id`,
      { id },
    ),
    // Records written in a context that retrieved this memory (decisions).
    roQuery<{ id: string; label: string; contextId: string }>(
      `MATCH (m:Memory {id:$id})<-[:RETRIEVED]-(ctx:Context)<-[:CREATED_IN]-(r:Decision)
       RETURN DISTINCT r.id AS id, r.description AS label, ctx.id AS contextId
       ORDER BY r.id`,
      { id },
    ),
    // Contexts this memory was written in (provenance coverage signal).
    roQuery<{ id: string }>(
      `MATCH (m:Memory {id:$id})-[:CREATED_IN]->(ctx:Context) RETURN ctx.id AS id ORDER BY ctx.id`,
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
    exposedTo: exposedTo.filter((e) => e.id),
    exposedRecords: [
      ...exposedMemories.filter((e) => e.id).map((e) => ({ id: e.id, label: e.label, kind: 'memory' as const, contextId: e.contextId })),
      ...exposedDecisions.filter((e) => e.id).map((e) => ({ id: e.id, label: e.label, kind: 'decision' as const, contextId: e.contextId })),
    ],
    createdInContexts: contexts.map((c) => c.id),
  };
}

export interface CreateMemoryInput {
  content: string;
  agentId: string;
  sourceType: string;
  sourceRef?: string;
  sourceTrusted: boolean;
  /**
   * Declared parent lineage. Accepts a single id (legacy clients) or an array
   * of ids (multiple parents). Each parent yields one DERIVED_FROM edge.
   */
  derivedFrom?: string | string[];
  /** Retrieval context this memory was written in; records observed exposure. */
  contextId?: string;
}

export interface CreateMemoryResult {
  memoryId: string;
  incidentId: string | null;
  /** Parents recorded as explicit DERIVED_FROM lineage (declared, confirmed). */
  derivedFrom: string[];
  /** Memories retrieved in `contextId` this record was exposed to (observed, unproven). */
  exposedTo: string[];
  contextId: string | null;
}

export async function createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult> {
  const memoryId = newId('mem');
  const ts = nowIso();
  const sourceId = newId('src');
  const trust = input.sourceTrusted ? 'trusted' : 'untrusted';
  const status = 'trusted'; // status transitions run only through the backend pipeline

  const parentIds = [
    ...new Set(
      Array.isArray(input.derivedFrom)
        ? input.derivedFrom
        : input.derivedFrom
          ? [input.derivedFrom]
          : [],
    ),
  ].filter((id) => id !== memoryId);

  const agentRows = await roQuery<{ id: string }>('MATCH (a:Agent {id:$agentId}) RETURN a.id AS id', {
    agentId: input.agentId,
  });
  if (!agentRows.length) throw new ValidationError(`unknown agent: ${input.agentId}`);

  if (parentIds.length > 0) {
    const rows = await roQuery<{ id: string }>('MATCH (m:Memory) WHERE m.id IN $ids RETURN m.id AS id', {
      ids: parentIds,
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = parentIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new ValidationError(`unknown parent memory id(s): ${missing.join(', ')}`);
  }

  if (input.contextId) {
    await assertContextOwnership(input.contextId, input.agentId);
  }

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

  // One DERIVED_FROM edge per declared parent (idempotent via UNWIND + MERGE).
  if (parentIds.length > 0) {
    await query(
      `MATCH (child:Memory {id:$cid})
       UNWIND $parents AS pid
       MATCH (parent:Memory {id:pid})
       MERGE (child)-[d:DERIVED_FROM]->(parent)
         SET d.evidence=$ev`,
      {
        cid: memoryId,
        parents: parentIds,
        ev: toJsonProp([{ kind: 'derivation', note: 'Created referencing parent memory' }]),
      },
    );
  }

  // Observed exposure: derived server-side from the context's recorded retrievals.
  let exposedTo: string[] = [];
  if (input.contextId) {
    exposedTo = await linkRecordToContext('Memory', memoryId, input.contextId, ts);
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

  return {
    memoryId,
    incidentId: result.incidentId,
    derivedFrom: parentIds,
    exposedTo,
    contextId: input.contextId ?? null,
  };
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
