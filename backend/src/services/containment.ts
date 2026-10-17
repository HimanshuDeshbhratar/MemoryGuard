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
  // Report the persisted containment state, not merely the rows transitioned by
  // this invocation. This keeps repeated quarantine reports idempotent.
  const [currentMemories, currentDecisions] = await Promise.all([
    roQuery<{ id: string; status: string }>(
      `MATCH (m:Memory)
       WHERE m.id IN $ids
       RETURN m.id AS id, m.status AS status`,
      { ids: blast.downstreamMemoryIds },
    ),
    roQuery<{ id: string; status: string }>(
      `MATCH (d:Decision)
       WHERE d.id IN $ids
       RETURN d.id AS id, d.status AS status`,
      { ids: blast.affectedDecisionIds },
    ),
  ]);
  const reviewMemories = currentMemories.filter((memory) => memory.status === 'review_required').map((memory) => memory.id);
  const reviewDecisions = currentDecisions.filter((decision) => decision.status === 'review_required').map((decision) => decision.id);
  return {
    incidentId,
    suspectMemoryId: memoryId,
    quarantined: [memoryId],
    flaggedForReview: { memories: reviewMemories, decisions: reviewDecisions },
    unresolved: {
      memories: blast.downstreamMemoryIds.filter((id) => !reviewMemories.includes(id)),
      decisions: blast.affectedDecisionIds.filter((id) => !reviewDecisions.includes(id)),
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
     OPTIONAL MATCH (m)-[:FLAGGED_BY]->(i:Incident)
     WITH m, collect(DISTINCT i) AS incidents
     SET m.status='trusted', m.updatedAt=$ts, m.revalidatedAt=$ts, m.revalidationReason=$reason
     FOREACH (incident IN incidents |
       MERGE (incident)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
         ON CREATE SET e.type='memory_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason
     )
     RETURN m.id AS id`,
    // A retry cannot reach this write after the status transition; a new UUID
    // therefore identifies this distinct, successfully-applied review action.
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
     OPTIONAL MATCH (i:Incident)-[:TARGETS]->(m)
     WITH m, collect(DISTINCT i) AS incidents
     SET m.status='trusted', m.updatedAt=$ts, m.revalidatedAt=$ts, m.revalidationReason=$reason
     FOREACH (incident IN incidents |
       MERGE (incident)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
       ON CREATE SET e.type='root_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason
     )
     RETURN m.id AS id`,
    // The state gate above keeps retries out of this write, while every later
    // quarantine/revalidation cycle receives an independently auditable event.
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
  if (badDeps.length > 0) {
    return { ok: false, blockedBy: badDeps };
  }
  if (status === 'revalidated') {
    return { ok: true, decisionId }; // idempotent only while its dependencies remain safe
  }

  const ts = nowIso();
  await query(
    `MATCH (d:Decision {id:$did})
     OPTIONAL MATCH (i:Incident)-[:AFFECTS]->(d)
     WITH d, collect(DISTINCT i) AS incidents
     SET d.status='revalidated', d.lastValidatedAt=$ts, d.revalidationReason=$reason
     FOREACH (incident IN incidents |
       MERGE (incident)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
       ON CREATE SET e.type='decision_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason
     )
     RETURN d.id AS id`,
    // A revalidated decision returns before this write on retry, so this UUID
    // is per successful revalidation action rather than per request attempt.
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
