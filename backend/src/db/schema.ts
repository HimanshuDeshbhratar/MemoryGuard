import { query } from './falkordb.js';
import { toJsonProp, parseJsonProp, type IncidentStatus } from '../lib/types.js';

/**
 * Graph schema (documented in docs/GRAPH_SCHEMA.md):
 *   (:Agent)-[:CREATED]->(:Memory)
 *   (:Memory)-[:DERIVED_FROM]->(:Memory)
 *   (:Memory)-[:SUPPORTED_BY]->(:Source)
 *   (:Decision)-[:DEPENDS_ON]->(:Memory)
 *   (:Incident)-[:TARGETS]->(:Memory)
 *   (:Incident)-[:AFFECTS]->(:Decision)
 *   (:Memory)-[:FLAGGED_BY]->(:Incident)   // a memory under review is tied to an incident
 *   (:Decision)-[:FLAGGED_BY]->(:Incident) // a decision under review is tied to an incident
 * Nodes carry `synthetic: true` and datasets carry `#SYNTHETIC DEMONSTRATION DATA#`
 * markers; nothing in this graph represents a real security incident.
 */
const MEMORY_STATUSES = ['trusted', 'suspicious', 'quarantined', 'review_required'];
const DECISION_STATUSES = ['active', 'review_required', 'revalidated', 'revoked'];
const INCIDENT_STATUSES = ['open', 'investigating', 'contained', 'resolved'];
const MEM_REL = [...'DERIVED_FROM SUPPORTED_BY CREATED DEPENDS_ON TARGETS AFFECTS FLAGGED_BY'.split(' ')];

export async function ensureConstraints(): Promise<void> {
  // Uniqueness/type protections supported by FalkorDB.
  // CREATE INDEX is not idempotent in older FalkorDB releases, so "already
  // indexed" responses are treated as success.
  for (const label of ['Agent', 'Memory', 'Source', 'Decision', 'Incident']) {
    try {
      await query(`CREATE INDEX FOR (n:${label}) ON (n.id)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already indexed|exists/i.test(msg)) throw err;
    }
  }
}

export function assertMemoryStatus(s: string): asserts s is 'trusted' | 'suspicious' | 'quarantined' | 'review_required' {
  if (!MEMORY_STATUSES.includes(s)) throw new Error(`invalid memory status: ${s}`);
}

export function assertDecisionStatus(s: string): asserts s is 'active' | 'review_required' | 'revalidated' | 'revoked' {
  if (!DECISION_STATUSES.includes(s)) throw new Error(`invalid decision status: ${s}`);
}

export function assertIncidentStatus(s: string): asserts s is IncidentStatus {
  if (!INCIDENT_STATUSES.includes(s)) throw new Error(`invalid incident status: ${s}`);
}

export const ALLOWED_RELATIONSHIPS = new Set(MEM_REL);

export type Evidence = { kind: string; note: string };

export async function attachEvidence(
  incidentId: string,
  evidence: Evidence[],
): Promise<void> {
  for (const e of evidence) {
    await query(
      `MERGE (i:Incident {id:$iid})
       CREATE (i)-[:EVIDENCE]->(e:Evidence {id:$eid, kind:$kind, note:$note, createdAt:$ts})`,
      { iid: incidentId, eid: `ev-${Math.random().toString(36).slice(2, 10)}`, kind: e.kind, note: e.note, ts: new Date().toISOString() },
    );
  }
}

export function evidenceFromQueryResult(row: Record<string, unknown>): Evidence[] {
  return parseJsonProp(row.evidence ?? [], []);
}
