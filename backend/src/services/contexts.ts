import { query, roQuery } from '../db/falkordb.js';
import { nowIso, truncate } from '../lib/types.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';

/**
 * Retrieval / exposure contexts.
 *
 * A `(:Context)` node records "agent A retrieved memories [m1, m2, …] while
 * working on one task". The context is owned by exactly one agent (first writer
 * wins) so a later write cannot be attributed to an unrelated agent/task.
 *
 * Retrieval is recorded evidence of *exposure* only: it never implies that the
 * retrieved memory caused any downstream output. Causality is unproven and the
 * graph keeps exposure in relationships that are distinct from the declared
 * `DERIVED_FROM` lineage.
 */
export interface RetrievalInput {
  contextId: string;
  agentId: string;
  memoryIds: string[];
  /** Optional caller-supplied request/correlation id, stored for traceability. */
  correlationId?: string;
}

export interface RetrievalResult {
  contextId: string;
  agentId: string;
  retrievedMemoryIds: string[];
  recordedAt: string;
  correlationId: string | null;
}

export interface ContextDetail {
  contextId: string;
  agentId: string;
  createdAt: string;
  correlationId: string | null;
  retrievedMemories: Array<{ id: string; content: string; status: string }>;
  exposedRecords: Array<{ id: string; label: string; kind: 'memory' | 'decision' }>;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

async function assertMemoriesExist(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await roQuery<{ id: string }>('MATCH (m:Memory) WHERE m.id IN $ids RETURN m.id AS id', { ids });
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new ValidationError(`unknown memory id(s): ${missing.join(', ')}`);
}

async function assertAgentExists(agentId: string): Promise<void> {
  const rows = await roQuery<{ id: string }>('MATCH (a:Agent {id:$agentId}) RETURN a.id AS id', { agentId });
  if (!rows.length) throw new ValidationError(`unknown agent: ${agentId}`);
}

/**
 * Validate that `contextId` exists and belongs to `agentId`.
 * Throws ValidationError when the context is unknown and ForbiddenError when it
 * is owned by a different agent — callers cannot silently join another task.
 */
export async function assertContextOwnership(contextId: string, agentId: string): Promise<void> {
  const rows = await roQuery<{ agentId: string }>(
    'MATCH (ctx:Context {id:$cid}) RETURN ctx.agentId AS agentId',
    { cid: contextId },
  );
  if (!rows.length) throw new ValidationError(`unknown context: ${contextId}`);
  if (rows[0].agentId !== agentId) {
    throw new ForbiddenError(`context ${contextId} belongs to another agent`);
  }
}

/** Record that `agentId` retrieved `memoryIds` inside `contextId` (idempotent). */
export async function recordRetrieval(input: RetrievalInput): Promise<RetrievalResult> {
  const memoryIds = uniqueIds(input.memoryIds);
  if (memoryIds.length === 0) throw new ValidationError('memoryIds must contain at least one memory id');
  if (memoryIds.length !== input.memoryIds.length) {
    // Duplicates are tolerated (idempotent MERGE) but we record the deduped set.
  }

  await assertAgentExists(input.agentId);
  await assertMemoriesExist(memoryIds);

  const existing = await roQuery<{ agentId: string }>(
    'MATCH (ctx:Context {id:$cid}) RETURN ctx.agentId AS agentId',
    { cid: input.contextId },
  );
  if (existing.length && existing[0].agentId !== input.agentId) {
    throw new ForbiddenError(`context ${input.contextId} belongs to another agent`);
  }

  const ts = nowIso();
  const correlationId = input.correlationId ?? null;

  await query(
    `MATCH (a:Agent {id:$agentId})
     MERGE (ctx:Context {id:$cid})
       ON CREATE SET ctx.createdAt=$ts, ctx.agentId=$agentId, ctx.correlationId=$correlationId, ctx.synthetic=true
     MERGE (a)-[:OPENED]->(ctx)`,
    { agentId: input.agentId, cid: input.contextId, ts, correlationId },
  );

  await query(
    `MATCH (ctx:Context {id:$cid})
     UNWIND $memoryIds AS mid
     MATCH (m:Memory {id:mid})
     MERGE (ctx)-[r:RETRIEVED]->(m)
       ON CREATE SET r.at=$ts`,
    { cid: input.contextId, memoryIds, ts },
  );

  return {
    contextId: input.contextId,
    agentId: input.agentId,
    retrievedMemoryIds: await listContextMemoryIds(input.contextId),
    recordedAt: ts,
    correlationId,
  };
}

async function listContextMemoryIds(contextId: string): Promise<string[]> {
  const rows = await roQuery<{ id: string }>(
    'MATCH (ctx:Context {id:$cid})-[:RETRIEVED]->(m:Memory) RETURN m.id AS id ORDER BY m.id',
    { cid: contextId },
  );
  return rows.map((r) => r.id);
}

/**
 * Link a freshly created record (memory or decision) to the context it was
 * written in, and materialise one `EXPOSED_TO` edge per memory that was
 * *actually* recorded as retrieved in that context.
 *
 * Exposure edges are derived server-side from `RETRIEVED` edges. A caller can
 * never inject an arbitrary exposure relationship by naming memory ids in the
 * write request.
 */
export async function linkRecordToContext(
  kind: 'Memory' | 'Decision',
  recordId: string,
  contextId: string,
  ts: string,
): Promise<string[]> {
  await query(
    `MATCH (ctx:Context {id:$cid}), (r:${kind} {id:$rid})
     MERGE (r)-[:CREATED_IN]->(ctx)`,
    { cid: contextId, rid: recordId },
  );
  const exposed = await query<{ id: string }>(
    `MATCH (ctx:Context {id:$cid})-[:RETRIEVED]->(src:Memory), (r:${kind} {id:$rid})
     MERGE (r)-[e:EXPOSED_TO]->(src)
       ON CREATE SET e.contextId=$cid, e.at=$ts
     RETURN DISTINCT src.id AS id`,
    { cid: contextId, rid: recordId, ts },
  );
  return exposed.map((r) => r.id);
}

/** Read a context and its recorded retrievals/exposed outputs, scoped to its owning agent. */
export async function getContext(contextId: string, agentId: string): Promise<ContextDetail> {
  const rows = await roQuery<{ agentId: string; createdAt: string; correlationId: string | null }>(
    `MATCH (ctx:Context {id:$cid})
     RETURN ctx.agentId AS agentId, ctx.createdAt AS createdAt, ctx.correlationId AS correlationId`,
    { cid: contextId },
  );
  if (!rows.length) throw new NotFoundError(`context ${contextId} not found`);
  if (rows[0].agentId !== agentId) throw new ForbiddenError(`context ${contextId} belongs to another agent`);

  const [memories, exposedMemories, exposedDecisions] = await Promise.all([
    roQuery<{ id: string; content: string; status: string }>(
      `MATCH (ctx:Context {id:$cid})-[:RETRIEVED]->(m:Memory)
       RETURN m.id AS id, m.content AS content, m.status AS status ORDER BY m.id`,
      { cid: contextId },
    ),
    roQuery<{ id: string; content: string }>(
      `MATCH (m:Memory)-[:CREATED_IN]->(ctx:Context {id:$cid})
       RETURN m.id AS id, m.content AS content ORDER BY m.id`,
      { cid: contextId },
    ),
    roQuery<{ id: string; description: string }>(
      `MATCH (d:Decision)-[:CREATED_IN]->(ctx:Context {id:$cid})
       RETURN d.id AS id, d.description AS description ORDER BY d.id`,
      { cid: contextId },
    ),
  ]);

  return {
    contextId,
    agentId: rows[0].agentId,
    createdAt: String(rows[0].createdAt),
    correlationId: rows[0].correlationId ?? null,
    retrievedMemories: memories.map((m) => ({ id: m.id, content: truncate(m.content, 160), status: m.status })),
    exposedRecords: [
      ...exposedMemories.map((m) => ({ id: m.id, label: truncate(m.content, 160), kind: 'memory' as const })),
      ...exposedDecisions.map((d) => ({ id: d.id, label: truncate(d.description, 160), kind: 'decision' as const })),
    ],
  };
}
