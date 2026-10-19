import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { clearTestGraph, TEST_GRAPH, testDb } from './setup.js';
import { closeFalkorDB } from '../src/db/falkordb.js';
import { seed } from '../src/services/demo.js';
import { computeBlastRadius } from '../src/services/blastRadius.js';
import { quarantine, revalidateDecision, revalidateMemory, revalidateQuarantinedRoot, listIncidentAudit } from '../src/services/containment.js';

/**
 * Regression suite for multi-parent lineage, retrieval-context exposure, and
 * exposure-aware containment.
 *
 * All fixtures are synthetic (#SYNTHETIC DEMONSTRATION DATA#). Tests run against
 * the isolated MEMORYGUARD_TEST graph and never touch the demo graph.
 */
const agent = () => request(app);

async function ro<T = Record<string, unknown>>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const db = await testDb();
  const res = await db.selectGraph(TEST_GRAPH).query(cypher, { params: params as never });
  return (res.data ?? []) as unknown as T[];
}

beforeAll(async () => {
  await clearTestGraph();
  await seed();
});

afterAll(async () => {
  await clearTestGraph();
  await closeFalkorDB();
});

beforeEach(async () => {
  await clearTestGraph();
  await seed();
});

/**
 * The core scenario from the task:
 *   agent-planning retrieves the suspicious root in ctx-1,
 *   writes a plan in ctx-1 WITHOUT declaring derivedFrom,
 *   and a decision depends on that plan.
 */
async function buildExposureScenario() {
  const retrieval = await agent()
    .post('/api/retrievals')
    .send({ contextId: 'ctx-1', agentId: 'agent-planning', memoryIds: ['mem-suspicious-root'] })
    .expect(201);

  const plan = await agent()
    .post('/api/memories')
    .send({
      content: 'Prepare the deployment plan for release-2026-11.',
      agentId: 'agent-planning',
      sourceType: 'agent_derivation',
      sourceTrusted: false,
      contextId: 'ctx-1',
    })
    .expect(201);

  const decision = await agent()
    .post('/api/decisions')
    .send({
      description: 'Execute the release-2026-11 deployment plan.',
      agentId: 'agent-deploy',
      dependsOn: [plan.body.memoryId],
    })
    .expect(201);

  return {
    retrieval: retrieval.body as { contextId: string; retrievedMemoryIds: string[] },
    planId: plan.body.memoryId as string,
    planBody: plan.body as { derivedFrom: string[]; exposedTo: string[]; contextId: string | null },
    decisionId: decision.body.decisionId as string,
  };
}

describe('multi-parent declared lineage', () => {
  it('legacy single-string derivedFrom still creates the parent edge', async () => {
    const res = await agent()
      .post('/api/memories')
      .send({
        content: 'Legacy child memory.',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        sourceTrusted: false,
        derivedFrom: 'mem-unrelated-trusted',
      })
      .expect(201);
    expect(res.body.derivedFrom).toEqual(['mem-unrelated-trusted']);
    const rows = await ro<{ id: string }>('MATCH (c:Memory {id:$id})-[:DERIVED_FROM]->(p:Memory) RETURN p.id AS id', {
      id: res.body.memoryId,
    });
    expect(rows.map((r) => r.id)).toEqual(['mem-unrelated-trusted']);
  });

  it('multiple parents create exactly one edge per parent', async () => {
    const parents = ['mem-suspicious-root', 'mem-unrelated-trusted', 'mem-deploy-notes'];
    const res = await agent()
      .post('/api/memories')
      .send({
        content: 'Memory derived from three declared parents.',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        sourceTrusted: false,
        derivedFrom: parents,
      })
      .expect(201);
    expect([...res.body.derivedFrom].sort()).toEqual([...parents].sort());
    const rows = await ro<{ id: string }>('MATCH (c:Memory {id:$id})-[:DERIVED_FROM]->(p:Memory) RETURN p.id AS id ORDER BY p.id', {
      id: res.body.memoryId,
    });
    expect(rows.map((r) => r.id)).toEqual([...parents].sort());
  });

  it('deduplicates repeated parent ids (no duplicate edges)', async () => {
    const res = await agent()
      .post('/api/memories')
      .send({
        content: 'Memory listing the same parent twice.',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        sourceTrusted: false,
        derivedFrom: ['mem-unrelated-trusted', 'mem-unrelated-trusted'],
      })
      .expect(201);
    expect(res.body.derivedFrom).toEqual(['mem-unrelated-trusted']);
    const rows = await ro<{ id: string }>('MATCH (c:Memory {id:$id})-[d:DERIVED_FROM]->(p:Memory) RETURN p.id AS id', {
      id: res.body.memoryId,
    });
    expect(rows).toHaveLength(1);
  });

  it('omitting derivedFrom remains compatible (no parent edges, no exposure)', async () => {
    const res = await agent()
      .post('/api/memories')
      .send({ content: 'Root memory with no declared parents.', agentId: 'agent-research', sourceType: 'other' })
      .expect(201);
    expect(res.body.derivedFrom).toEqual([]);
    expect(res.body.exposedTo).toEqual([]);
    expect(res.body.contextId).toBeNull();
  });

  it('rejects nonexistent parent ids and does not create the memory', async () => {
    await agent()
      .post('/api/memories')
      .send({
        content: 'reject-me-nonexistent-parent',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        derivedFrom: ['mem-does-not-exist'],
      })
      .expect(400);
    const rows = await ro<{ n: number }>('MATCH (m:Memory {content:"reject-me-nonexistent-parent"}) RETURN count(m) AS n');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('rejects a malformed derivedFrom payload', async () => {
    await agent()
      .post('/api/memories')
      .send({
        content: 'bad shape',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        derivedFrom: [{ not: 'an id' }],
      })
      .expect(400);
  });
});

describe('retrieval context + observed exposure', () => {
  it('records retrieval and correlates a later write in the same context', async () => {
    const { retrieval, planBody } = await buildExposureScenario();
    expect(retrieval.contextId).toBe('ctx-1');
    expect(retrieval.retrievedMemoryIds).toEqual(['mem-suspicious-root']);
    // The plan declares no parent, but is exposed to what was actually retrieved.
    expect(planBody.derivedFrom).toEqual([]);
    expect(planBody.exposedTo).toEqual(['mem-suspicious-root']);
    expect(planBody.contextId).toBe('ctx-1');
  });

  it('rejects unknown agents and unknown memories on retrieval', async () => {
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-x', agentId: 'agent-nope', memoryIds: ['mem-unrelated-trusted'] })
      .expect(400);
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-x', agentId: 'agent-research', memoryIds: ['mem-nope'] })
      .expect(400);
  });

  it('enforces context ownership across agents', async () => {
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-owned', agentId: 'agent-planning', memoryIds: ['mem-unrelated-trusted'] })
      .expect(201);

    // Another agent cannot append to the context.
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-owned', agentId: 'agent-deploy', memoryIds: ['mem-deploy-notes'] })
      .expect(403);

    // Another agent cannot write into the context.
    await agent()
      .post('/api/memories')
      .send({ content: 'cross-agent write', agentId: 'agent-deploy', sourceType: 'other', contextId: 'ctx-owned' })
      .expect(403);

    // Another agent cannot read the context's records.
    await agent().get('/api/contexts/ctx-owned?agentId=agent-deploy').expect(403);
    const ok = await agent().get('/api/contexts/ctx-owned?agentId=agent-planning').expect(200);
    expect(ok.body.agentId).toBe('agent-planning');
    expect(ok.body.retrievedMemories.map((m: { id: string }) => m.id)).toEqual(['mem-unrelated-trusted']);
  });

  it('rejects an unknown context when writing a memory', async () => {
    await agent()
      .post('/api/memories')
      .send({ content: 'no such context', agentId: 'agent-research', sourceType: 'other', contextId: 'ctx-missing' })
      .expect(400);
  });

  it('a retrieval in ctx-1 does not affect an unrelated write in ctx-2', async () => {
    await buildExposureScenario();
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-2', agentId: 'agent-planning', memoryIds: ['mem-unrelated-trusted'] })
      .expect(201);
    const other = await agent()
      .post('/api/memories')
      .send({ content: 'Unrelated note written in ctx-2.', agentId: 'agent-planning', sourceType: 'other', contextId: 'ctx-2' })
      .expect(201);

    expect(other.body.exposedTo).toEqual(['mem-unrelated-trusted']);
    expect(other.body.exposedTo).not.toContain('mem-suspicious-root');

    const blast = await computeBlastRadius('inc-auth-checks');
    expect(blast.exposedMemoryIds).not.toContain(other.body.memoryId);
  });

  it('exposure cannot be injected through the request body', async () => {
    await agent()
      .post('/api/retrievals')
      .send({ contextId: 'ctx-3', agentId: 'agent-research', memoryIds: ['mem-unrelated-trusted'] })
      .expect(201);
    // A caller cannot name arbitrary exposure relationships; unknown fields are ignored.
    const res = await agent()
      .post('/api/memories')
      .send({
        content: 'Attempting to declare arbitrary exposure.',
        agentId: 'agent-research',
        sourceType: 'other',
        contextId: 'ctx-3',
        exposedTo: ['mem-suspicious-root'],
      })
      .expect(201);
    expect(res.body.exposedTo).toEqual(['mem-unrelated-trusted']);
    expect(res.body.exposedTo).not.toContain('mem-suspicious-root');
  });

  it('a retrieved memory is treated as exposure only, never as declared lineage', async () => {
    const { planId } = await buildExposureScenario();
    const derived = await ro<{ n: number }>('MATCH (m:Memory {id:$id})-[:DERIVED_FROM]->(:Memory) RETURN count(*) AS n', { id: planId });
    const exposed = await ro<{ n: number }>('MATCH (m:Memory {id:$id})-[:EXPOSED_TO]->(:Memory) RETURN count(*) AS n', { id: planId });
    expect(Number(derived[0].n)).toBe(0); // no declared lineage
    expect(Number(exposed[0].n)).toBe(1); // observed exposure only

    await quarantine('inc-auth-checks');
    const status = await ro<{ s: string }>('MATCH (m:Memory {id:$id}) RETURN m.status AS s', { id: planId });
    // Exposed records are flagged for review, not declared malicious.
    expect(status[0].s).toBe('review_required');
  });
});

describe('exposure-aware investigation and containment', () => {
  it('separates observed exposure from confirmed lineage in the blast radius', async () => {
    const { planId, decisionId } = await buildExposureScenario();
    const blast = await computeBlastRadius('inc-auth-checks');

    // Declared lineage is unchanged (seeded DERIVED_FROM path only).
    expect(blast.downstreamMemoryIds).toContain('mem-derived-plan');
    expect(blast.downstreamMemoryIds).not.toContain(planId);
    expect(blast.affectedDecisionIds).not.toContain(decisionId);

    // Exposure is reported independently.
    expect(blast.exposedMemoryIds).toContain(planId);
    expect(blast.exposedDecisionIds).toContain(decisionId);
    expect(blast.exposureContextIds).toContain('ctx-1');
  });

  it('reports incomplete provenance coverage honestly', async () => {
    const { planId } = await buildExposureScenario();
    const blast = await computeBlastRadius('inc-auth-checks');
    expect(blast.provenance.coverageComplete).toBe(false);
    expect(blast.provenance.unprovenancedMemories).toBeGreaterThan(0);
    expect(blast.provenance.exposureRelationshipCount).toBeGreaterThanOrEqual(1);
    expect(blast.provenance.caveat).toMatch(/not evidence of absence/i);
    // Sanity: the plan itself is covered (it has a recorded context).
    const covered = await ro<{ n: number }>('MATCH (m:Memory {id:$id})-[:CREATED_IN]->(:Context) RETURN count(*) AS n', { id: planId });
    expect(Number(covered[0].n)).toBe(1);
  });

  it('quarantine flags the uncited plan and its dependent decision through exposure', async () => {
    const { planId, decisionId } = await buildExposureScenario();
    const report = await quarantine('inc-auth-checks');

    expect(report.flaggedForReview.memories).toContain(planId);
    expect(report.flaggedForReview.decisions).toContain(decisionId);
    expect(report.exposed.memories).toContain(planId);
    expect(report.exposed.decisions).toContain(decisionId);
    expect(report.exposed.contextIds).toContain('ctx-1');

    const statuses = await ro<{ id: string; s: string }>(
      `MATCH (m:Memory) WHERE m.id IN $ids RETURN m.id AS id, m.status AS s`,
      { ids: [planId, 'mem-suspicious-root'] },
    );
    const byId = Object.fromEntries(statuses.map((r) => [r.id, r.s]));
    expect(byId['mem-suspicious-root']).toBe('quarantined');
    expect(byId[planId]).toBe('review_required');
  });

  it('does not duplicate flags when a record is reachable by both declared and exposure paths', async () => {
    const { planId } = await buildExposureScenario();
    const dual = await agent()
      .post('/api/memories')
      .send({
        content: 'Reachable by both declared lineage and exposure.',
        agentId: 'agent-planning',
        sourceType: 'agent_derivation',
        derivedFrom: ['mem-suspicious-root'],
        contextId: 'ctx-1',
      })
      .expect(201);
    expect(dual.body.derivedFrom).toEqual(['mem-suspicious-root']);
    expect(dual.body.exposedTo).toEqual(['mem-suspicious-root']);

    const report = await quarantine('inc-auth-checks');
    expect(report.flaggedForReview.memories.filter((id) => id === dual.body.memoryId)).toHaveLength(1);
    expect(report.flaggedForReview.memories.filter((id) => id === planId)).toHaveLength(1);
  });

  it('repeated quarantine stays idempotent (no duplicate audit events or flags)', async () => {
    await buildExposureScenario();
    const first = await quarantine('inc-auth-checks');
    const second = await quarantine('inc-auth-checks');
    expect(second.quarantined).toEqual(first.quarantined);
    expect(second.flaggedForReview).toEqual(first.flaggedForReview);
    expect(second.unresolved).toEqual({ memories: [], decisions: [] });
    const events = (await listIncidentAudit('inc-auth-checks')).filter((e) => e.type === 'quarantine_applied');
    expect(events).toHaveLength(1);
  });

  it('revalidation gating blocks a decision that depends on an exposed record', async () => {
    const { decisionId, planId } = await buildExposureScenario();
    await quarantine('inc-auth-checks');

    const blocked = await revalidateDecision(decisionId, 'Trying to approve an exposed decision.');
    expect(blocked.ok).toBe(false);
    expect((blocked as { blockedBy: string[] }).blockedBy).toContain(planId);

    // The gate opens only after each upstream record is independently revalidated.
    expect((await revalidateQuarantinedRoot('mem-suspicious-root', 'Synthetic content; verified inert for this test.')).ok).toBe(true);
    expect((await revalidateMemory(planId, 'Exposed plan reviewed; benign intent confirmed.')).ok).toBe(true);
    const allowed = await revalidateDecision(decisionId, 'Dependencies reviewed after independent revalidation.');
    expect(allowed.ok).toBe(true);
  });
});
