# FalkorDB graph reference — `MEMORYGUARD`

All queries are executed through parameterized helpers (`query` / `roQuery` in `backend/src/db/falkordb.ts`). User-controlled values always arrive as parameters, never interpolated strings. Every node write uses `MERGE (n:Label {id:$id})` so seeds and re-runs are idempotent; repeated runs never duplicate nodes.

## Constraints / indexes

`backend/src/db/schema.ts` creates them idempotently at startup:

```cypher
CREATE INDEX FOR (m:Memory) ON (m.id)
CREATE INDEX FOR (d:Decision) ON (d.id)
CREATE INDEX FOR (i:Incident) ON (i.id)
CREATE INDEX FOR (a:Agent) ON (a.id)
CREATE INDEX FOR (s:Source) ON (s.id)
```

Note: the graph key must exist before `CREATE INDEX` succeeds, so the seed path creates the graph explicitly right after a drop.

## Node / relationship model

See README §Graph schema for the property tables. Relationship direction is fixed:

```
(:Agent)-[:CREATED]->(:Memory)
(:Memory)-[:DERIVED_FROM]->(:Memory)        // edge property: evidence (JSON)
(:Memory)-[:SUPPORTED_BY]->(:Source)
(:Decision)-[:DEPENDS_ON]->(:Memory)        // edge property: evidence (JSON)
(:Incident)-[:TARGETS]->(:Memory)
(:Incident)-[:AFFECTS]->(:Decision)         // created when (& persisted with) the incident
(:Memory)-[:FLAGGED_BY]->(:Incident)        // set by quarantine
(:Decision)-[:FLAGGED_BY]->(:Incident)
(:Incident)-[:HAS_EVENT]->(:AuditEvent)     // quarantine / revalidation audit trail
```

## Detection

When a new memory is written, `services/detection.ts` runs the deterministic evaluator over the protected policies. On a confirmed match it persists the incident:

```cypher
MERGE (i:Incident {id:$id})
  SET i.title=$title, i.severity=$severity, i.reason=$reason,
      i.status=$status, i.createdAt=$createdAt, i.evidence=$evidence
WITH i MATCH (m:Memory {id:$targetMemory})
MERGE (i)-[t:TARGETS]->(m) SET t.createdAt=$createdAt
```

## Blast radius (downstream impact)

Implemented in `services/blastRadius.ts`, bounded by `TRAVERSAL` limits (max depth 6, max nodes 500; truncation is reported):

**Downstream memories (parameter-free bounds — FalkorDB does not support `*1..$maxDepth`):**

```cypher
MATCH (m:Memory {id:$mid})<-[:DERIVED_FROM]-()
CALL { ... }                                  // variable-length path expansion
```

(see `blastRadius.ts` for the exact inlined-depth Cypher; the traversal returns `m.id`, `m.content`, `m.status`, creating agent, and hop `depth`).

**Affected decisions** — decisions with a transitive `DEPENDS_ON` path into the suspect memory:

```cypher
MATCH (d:Decision)-[:DEPENDS_ON*1..]->(m:Memory {id:$mid})
RETURN d.id AS decisionId
```

**Influence chains** — end-to-end paths used to render the UI chains:

```cypher
MATCH p = (m:Memory {id:$mid})<-[:DERIVED_FROM*1..]-()
RETURN nodes(p) AS chain
```

**Exclusion guarantee:** unrelated memories only appear in results if a real `DERIVED_FROM`/`DEPENDS_ON` path connects them to the suspect — the traversal is the only source of edges.

## Quarantine & revalidation (containment)

`services/containment.ts`:

```cypher
-- 1. Quarantine the suspect memory (idempotent)
MATCH (m:Memory {id:$mid})
WHERE m.status IN ['trusted','suspicious']
SET m.status='quarantined', m.updatedAt=$ts, m.quarantineReason=$reason
RETURN m.id AS id

-- 2. Flag dependents for review
MATCH (m:Memory {id:$mid})<-[:DERIVED_FROM*1..]-(dm:Memory)
WHERE dm.status IN ['trusted','suspicious']
SET dm.status='review_required', dm.updatedAt=$ts

MATCH (d:Decision)-[:DEPENDS_ON*1..]->(:Memory {id:$mid})
WHERE d.status = 'active'
SET d.status='review_required', d.updatedAt=$ts
MERGE (d)-[:FLAGGED_BY]->(i:Incident {id:$incidentId})
```

**Gated revalidation:** `revalidateDecision` refuses (`ok:false` → HTTP 409) while the decision still depends on a quarantined memory:

```cypher
MATCH (d:Decision {id:$did})-[:DEPENDS_ON*1..]->(m:Memory)
WHERE m.status = 'quarantined'
RETURN count(m) AS blocked
```

The quarantined root itself can only be revalidated through `POST /api/memories/:id/revalidate?root=true`, which is validated against an explicit reason. Every status change is persisted as a graph property and an `AuditEvent`, so a backend restart or frontend refresh restores exactly the stored state — quarantined memory stays quarantined.
