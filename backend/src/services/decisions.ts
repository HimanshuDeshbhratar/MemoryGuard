import { query, roQuery } from '../db/falkordb.js';
import { newId, nowIso, toJsonProp } from '../lib/types.js';
import { ValidationError } from '../lib/errors.js';
import { assertContextOwnership, linkRecordToContext } from './contexts.js';

/**
 * Minimal, validated decision creation.
 *
 * Decisions are the second kind of "output" an agent can write. When a decision
 * is written inside a retrieval context, it receives the same
 * `CREATED_IN` / `EXPOSED_TO` provenance as a memory — observed exposure, never
 * declared derivation.
 */
export interface CreateDecisionInput {
  description: string;
  agentId: string;
  /** Memory ids this decision explicitly depends on (declared lineage). */
  dependsOn?: string[];
  /** Retrieval context this decision was written in, if any. */
  contextId?: string;
}

export interface CreateDecisionResult {
  decisionId: string;
  dependsOn: string[];
  exposedTo: string[];
  contextId: string | null;
}

export async function createDecision(input: CreateDecisionInput): Promise<CreateDecisionResult> {
  const dependsOn = [...new Set(input.dependsOn ?? [])];

  const agentRows = await roQuery<{ id: string }>('MATCH (a:Agent {id:$agentId}) RETURN a.id AS id', {
    agentId: input.agentId,
  });
  if (!agentRows.length) throw new ValidationError(`unknown agent: ${input.agentId}`);

  if (dependsOn.length > 0) {
    const rows = await roQuery<{ id: string }>('MATCH (m:Memory) WHERE m.id IN $ids RETURN m.id AS id', { ids: dependsOn });
    const found = new Set(rows.map((r) => r.id));
    const missing = dependsOn.filter((id) => !found.has(id));
    if (missing.length > 0) throw new ValidationError(`unknown dependency memory id(s): ${missing.join(', ')}`);
  }

  if (input.contextId) {
    await assertContextOwnership(input.contextId, input.agentId);
  }

  const decisionId = newId('dec');
  const ts = nowIso();

  await query(
    `MATCH (a:Agent {id:$agentId})
     CREATE (d:Decision {
       id:$did, description:$description, status:'active',
       createdAt:$ts, lastValidatedAt:$ts, synthetic:true
     })
     MERGE (a)-[:CREATED]->(d)`,
    { agentId: input.agentId, did: decisionId, description: input.description, ts },
  );

  if (dependsOn.length > 0) {
    await query(
      `MATCH (d:Decision {id:$did})
       UNWIND $dependsOn AS mid
       MATCH (m:Memory {id:mid})
       MERGE (d)-[de:DEPENDS_ON]->(m)
         ON CREATE SET de.evidence=$evidence`,
      {
        did: decisionId,
        dependsOn,
        evidence: toJsonProp([{ kind: 'dependency', note: 'Decision references this memory as an input to its rationale' }]),
      },
    );
  }

  let exposedTo: string[] = [];
  if (input.contextId) {
    exposedTo = await linkRecordToContext('Decision', decisionId, input.contextId, ts);
  }

  return { decisionId, dependsOn, exposedTo, contextId: input.contextId ?? null };
}
