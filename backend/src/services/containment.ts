import { query, roQuery } from '../db/falkordb.js';
import { computeBlastRadius } from './blastRadius.js';
import { newId, nowIso, TRAVERSAL } from '../lib/types.js';

export interface QuarantineReport {
  incidentId: string;
  suspectMemoryId: string | null;
  quarantined: string[];
  flaggedForReview: { memories: string[]; decisions: string[] };
  unresolved: { memories: string[]; decisions: string[] };
}

/**
 * Quarantine the suspect memory that the incident TARGETS.
 * Idempotent: running twice does not duplicate audit events or change state further.
 */
export async function quarantine(incidentId: string): Promise<QuarantineReport> {
  const target = await roQuery<{ memoryId: string }>(
    'MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory) RETURN m.id AS memoryId',
    { iid: incidentId },
  );
  const memoryId = target[0]?.memoryId;
  if (!memoryId) throw new Error(`incident ${incidentId} has no TARGET memory`);

  // 1. Mark suspect memory quarantined + incident contained (idempotent SETs).
  await query(
    `MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory)
     SET m.status='quarantined', m.updatedAt=$ts, m.quarantinedAt=$ts,
         i.status=CASE WHEN i.status IN ['open','investigating'] THEN 'contained' ELSE i.status END,
         i.containedAt=coalesce(i.containedAt, $ts)
     RETURN i.id AS incidentId, m.id AS memoryId`,
    { iid: incidentId, ts: nowIso() },
  );

  // 2. Record containment audit event (MERGE keeps it idempotent).
  await query(
    `MATCH (i:Incident {id:$iid})
     MERGE (e:AuditEvent {id:$eid})
       ON CREATE SET e.type='quarantine_applied', e.actor='operator', e.createdAt=$ts, e.reason=$reason
     MERGE (i)-[:HAS_EVENT]->(e)
     RETURN e.id AS eventId`,
    { iid: incidentId, eid: `${incidentId}-quarantine`, ts: nowIso(), reason: 'operator confirmed containment' },
  );

  // 3. Mark downstream derived memories review_required (skip already-quarantined ones).
  const memoryFlagRows = await query<{ memoryIds: string[] }>(
    `MATCH (root:Memory {id:$mid})<-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]-(m:Memory)
     WHERE m.status IN ['trusted','suspicious']
     SET m.status='review_required', m.updatedAt=$ts
     RETURN collect(DISTINCT m.id) AS memoryIds`,
    { mid: memoryId, ts: nowIso() },
  );
  const flaggedMemories = memoryFlagRows[0]?.memoryIds ?? [];

  // 4. Flag affected decisions for review.
  const decisionFlagRows = await query<{ decisionIds: string[] }>(
    `MATCH (i:Incident {id:$iid})-[:AFFECTS]->(d:Decision)
     WHERE d.status IN ['active','revalidated']
     SET d.status='review_required', d.updatedAt=$ts
     RETURN collect(DISTINCT d.id) AS decisionIds`,
    { iid: incidentId, ts: nowIso() },
  );
  const flaggedDecisions = decisionFlagRows[0]?.decisionIds ?? [];

  // 4b. Relate flagged records back to the incident for traceability.
  if (flaggedMemories.length > 0) {
    await query(
      `MATCH (i:Incident {id:$iid}), (m:Memory)
       WHERE m.id IN $memIds
       MERGE (m)-[f:FLAGGED_BY]->(i) ON CREATE SET f.createdAt=$ts`,
      { iid: incidentId, memIds: flaggedMemories, ts: nowIso() },
    );
  }
  if (flaggedDecisions.length > 0) {
    await query(
      `MATCH (i:Incident {id:$iid}), (d:Decision)
       WHERE d.id IN $decIds
       MERGE (d)-[f:FLAGGED_BY]->(i) ON CREATE SET f.createdAt=$ts`,
      { iid: incidentId, decIds: flaggedDecisions, ts: nowIso() },
    );
  }

  // 5. Re-run impact analysis for the report.
  const blast = await computeBlastRadius(incidentId);
  return {
    incidentId,
    suspectMemoryId: memoryId,
    quarantined: [memoryId],
    flaggedForReview: { memories: flaggedMemories, decisions: flaggedDecisions },
    unresolved: {
      memories: blast.downstreamMemoryIds.filter((id) => !flaggedMemories.includes(id)),
      decisions: blast.affectedDecisionIds.filter((id) => !flaggedDecisions.includes(id)),
    },
  };
}

/** A memory may not be revalidated while an ancestor it derives from is still quarantined. */
async function checkQuarantinedAncestors(memoryId: string): Promise<string[]> {
  const rows = await roQuery<{ ids: string[] }>(
    `MATCH (m:Memory {id:$mid})-[:DERIVED_FROM*1..${TRAVERSAL.maxDepth}]->(ancestor:Memory)
     WHERE ancestor.status='quarantined'
     RETURN collect(DISTINCT ancestor.id) AS ids`,
    { mid: memoryId },
  );
  return rows[0]?.ids ?? [];
}

/** Revalidation of a review_required memory (returns trusted) with required reason. */
export async function revalidateMemory(
  memoryId: string,
  reason: string,
  actor = 'operator',
): Promise<
  | { ok: true; memoryId: string; previousStatus: string; newStatus: string; revalidatedAt: string; reason: string }
  | { ok: false; blockedBy: string[] }
> {
  const rows = await roQuery<{ status: string }>(
    'MATCH (m:Memory {id:$mid}) RETURN m.status AS status',
    { mid: memoryId },
  );
  if (!rows.length) throw new NotFoundError(`memory ${memoryId} not found`);
  const previousStatus = rows[0].status;

  if (previousStatus === 'quarantined') {
    return { ok: false, blockedBy: [`memory ${memoryId} is quarantined (root); use the explicit root revalidation action`] };
  }
  if (previousStatus !== 'review_required') {
    return { ok: false, blockedBy: [`memory status is '${previousStatus}', only 'review_required' can be revalidated`] };
  }

  const quarantinedAncestors = await checkQuarantinedAncestors(memoryId);
  if (quarantinedAncestors.length > 0) {
    return { ok: false, blockedBy: quarantinedAncestors };
  }

  const ts = nowIso();
  await query(
    `MATCH (m:Memory {id:$mid})
     SET m.status='trusted', m.updatedAt=$ts, m.revalidatedAt=$ts, m.revalidationReason=$reason
     RETURN m.id AS id`,
    { mid: memoryId, ts, reason },
  );
  await query(
    `MATCH (m:Memory {id:$mid})
     OPTIONAL MATCH (i:Incident)-[:FLAGGED_BY]->(m)
     WITH m, collect(i.id) AS incidentIds
     UNWIND (CASE WHEN size(incidentIds)=0 THEN [null] ELSE incidentIds END) AS iid
     WITH m, iid
     OPTIONAL MATCH (i2:Incident) WHERE i2.id = iid
     FOREACH (_ IN CASE WHEN i2 IS NOT NULL THEN [1] ELSE [] END |
       MERGE (i2)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
         ON CREATE SET e.type='memory_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason
     )`,
    { mid: memoryId, ts, reason, eid: newId('evt'), actor },
  );

  return { ok: true, memoryId, previousStatus, newStatus: 'trusted', revalidatedAt: ts, reason };
}

/** Explicit root re-validation: marks a quarantined suspect memory reviewed + trusted. */
export async function revalidateQuarantinedRoot(
  memoryId: string,
  reason: string,
  actor = 'operator',
): Promise<{ ok: true; memoryId: string } | { ok: false; blockedBy: string[] }> {
  const rows = await roQuery<{ status: string }>(
    'MATCH (m:Memory {id:$mid}) RETURN m.status AS status',
    { mid: memoryId },
  );
  if (!rows.length) throw new NotFoundError(`memory ${memoryId} not found`);
  if (rows[0].status !== 'quarantined') {
    return { ok: false, blockedBy: [`memory status is '${rows[0].status}', not quarantined`] };
  }

  const ts = nowIso();
  await query(
    `MATCH (m:Memory {id:$mid})
     SET m.status='trusted', m.updatedAt=$ts, m.revalidatedAt=$ts, m.revalidationReason=$reason
     RETURN m.id AS id`,
    { mid: memoryId, ts, reason },
  );
  await query(
    `MATCH (i:Incident)-[:TARGETS]->(m:Memory {id:$mid})
     MERGE (i)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
       ON CREATE SET e.type='root_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason`,
    { mid: memoryId, ts, reason, eid: newId('evt'), actor },
  );
  return { ok: true, memoryId };
}

/** Decision revalidation: allowed only when no DEPENDS_ON memory (or any transitive DERIVED_FROM ancestor) is quarantined/review_required. */
export async function revalidateDecision(
  decisionId: string,
  reason: string,
  actor = 'operator',
): Promise<{ ok: true; decisionId: string } | { ok: false; blockedBy: string[] }> {
  // Expand: follow DEPENDS_ON to every direct memory dependency, then follow
  // DERIVED_FROM ancestry up to maxDepth hops from each dependency.
  // Block if any memory in that full set has a non-safe status.
  const rows = await roQuery<{ status: string; blocked: (string | null)[] }>(
    `MATCH (d:Decision {id:$did})
     OPTIONAL MATCH (d)-[:DEPENDS_ON]->(m:Memory)
     OPTIONAL MATCH (m)-[:DERIVED_FROM*0..${TRAVERSAL.maxDepth}]->(ancestor:Memory)
     WITH d,
          collect(DISTINCT CASE WHEN ancestor.status IN ['quarantined','review_required'] THEN ancestor.id END) AS blocked
     RETURN d.status AS status,
            [x IN blocked WHERE x IS NOT NULL] AS blocked`,
    { did: decisionId },
  );
  if (!rows.length) throw new NotFoundError(`decision ${decisionId} not found`);
  const { status, blocked } = rows[0];
  const badDeps = (blocked ?? []).filter((x): x is string => Boolean(x));
  if (status === 'revalidated') {
    return { ok: true, decisionId }; // idempotent
  }
  if (badDeps.length > 0) {
    return { ok: false, blockedBy: badDeps };
  }

  const ts = nowIso();
  await query(
    `MATCH (d:Decision {id:$did})
     SET d.status='revalidated', d.lastValidatedAt=$ts, d.revalidationReason=$reason
     RETURN d.id AS id`,
    { did: decisionId, ts, reason },
  );
  await query(
    `MATCH (i:Incident)-[:AFFECTS]->(d:Decision {id:$did})
     MERGE (i)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
       ON CREATE SET e.type='decision_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason`,
    { did: decisionId, ts, reason, eid: newId('evt'), actor },
  );
  return { ok: true, decisionId };
}

export async function listIncidentAudit(incidentId: string) {
  return roQuery<{ id: string; type: string; actor: string; reason: string; createdAt: string }>(
    `MATCH (i:Incident {id:$iid})-[:HAS_EVENT]->(e:AuditEvent)
     RETURN e.id AS id, e.type AS type, e.actor AS actor, e.reason AS reason, e.createdAt AS createdAt
     ORDER BY e.createdAt ASC`,
    { iid: incidentId },
  );
}

export class NotFoundError extends Error {}
