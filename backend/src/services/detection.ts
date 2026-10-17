import { query } from '../db/falkordb.js';
import { evaluate, type PolicyEvaluation } from '../policies/policies.js';
import { newId, nowIso, toJsonProp, truncate } from '../lib/types.js';
import { computeBlastRadius } from './blastRadius.js';

export interface DetectionResult {
  memoryId: string;
  evaluation: PolicyEvaluation;
  incidentId: string | null;
  impact: Awaited<ReturnType<typeof computeBlastRadius>> | null;
}

/**
 * Detection pipeline (deterministic, zero-cost):
 * 1. normalize/validate input (route layer)
 * 2. evaluate against protected policies
 * 3. persist memory (route calls this after upsert) and, on conflict or signal,
 *    create an Incident with TARGETS/AFFECTS provenance + evidence
 * 4. compute bounded blast radius for the structured report
 *
 * Memory content is untrusted data: it is only pattern-matched here, never executed.
 */
export async function createIncidentForMemory(
  memoryId: string,
  evaluation: PolicyEvaluation,
): Promise<string> {
  const incidentId = newId('inc');
  const ts = nowIso();
  const policy = evaluation.policy;
  const evidence = toJsonProp([
    {
      kind: 'policy_match',
      note: `Policy ${policy?.id ?? 'unknown'}: ${evaluation.evidenceNote}`,
      matches: evaluation.matches.map((m) => ({
        field: m.matcher.field,
        excerpt: truncate(m.excerpt, 120),
      })),
    },
  ]);

  await query(
    `MATCH (m:Memory {id:$mid})
     CREATE (i:Incident {
       id:$iid, title:$title, severity:$severity, confidence:$confidence,
       reason:$reason, status:'open', createdAt:$ts, containedAt:null,
       synthetic:true, evidence:$evidence, policyId:$pid
     })
     MERGE (i)-[t:TARGETS]->(m) ON CREATE SET t.createdAt=$ts
     RETURN i.id AS id`,
    {
      mid: memoryId,
      iid: incidentId,
      title: `${evaluation.confidence === 'signal' ? 'Suspicious signal' : 'Protected policy conflict'}: ${policy?.title ?? 'policy'}`,
      severity: policy?.severity ?? 'high',
      confidence: evaluation.confidence,
      reason: evaluation.evidenceNote,
      pid: policy?.id ?? '',
      evidence,
      ts,
    },
  );

  // Link decisions that transitively depend on the suspect memory.
  await query(
    `MATCH (i:Incident {id:$iid})
     MATCH (d:Decision)-[:DEPENDS_ON*1..6]->(:Memory {id:$mid})
     WHERE NOT ( (i)-[:AFFECTS]->(d) )
     MERGE (i)-[a:AFFECTS]->(d) ON CREATE SET a.createdAt=$ts,
       a.evidence=$ev`, 
    {
      iid: incidentId,
      mid: memoryId,
      ts,
      ev: toJsonProp([{ kind: 'impact', note: 'Decision transitively depends on the suspect memory' }]),
    },
  );

  return incidentId;
}

export async function evaluateNewMemory(args: {
  memoryId: string;
  content: string;
  sourceType: string;
  sourceTrusted: boolean;
}): Promise<DetectionResult> {
  const evaluation = evaluate({
    content: args.content,
    sourceType: args.sourceType,
    sourceTrusted: args.sourceTrusted,
  });

  if (!evaluation.triggered) {
    return { memoryId: args.memoryId, evaluation, incidentId: null, impact: null };
  }
  const incidentId = await createIncidentForMemory(args.memoryId, evaluation);
  const impact = await computeBlastRadius(incidentId);
  return { memoryId: args.memoryId, evaluation, incidentId, impact };
}
