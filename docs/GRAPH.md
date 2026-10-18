# FalkorDB graph reference — `MEMORYGUARD`

This document describes the **actual** FalkorDB model and the Cypher operations the
backend runs. Query bodies are copied from the TypeScript sources; the only edit is
that runtime interpolation of the constants `TRAVERSAL.maxDepth` (**6**) and
`TRAVERSAL.maxNodes` (**200**) is shown as the resolved literal, because FalkorDB
does not accept a parameter in `*1..$n` or `LIMIT $n` in every position. Every node
write uses stable `id`s and `MERGE`, so seeds and retries are idempotent.

- Connection + helpers: `backend/src/db/falkordb.ts` (`query`, `roQuery`)
- Schema/index setup: `backend/src/db/schema.ts` (`ensureConstraints`)
- Traversal limits: `backend/src/lib/types.ts` (`TRAVERSAL = { maxDepth: 6, maxNodes: 200 }`)

All queries are executed through parameterized helpers. User-controlled values always
arrive as parameters (`$id`, `$mid`, `$reason`, …) and are never interpolated into the
query text.

---

## 1. Indexes

Created idempotently at startup (`ensureConstraints`). "Already indexed" responses are
treated as success because older FalkorDB releases are not idempotent here. The label is
taken from a fixed literal list — never from user input.

```cypher
CREATE INDEX FOR (n:Agent)    ON (n.id)
CREATE INDEX FOR (n:Memory)   ON (n.id)
CREATE INDEX FOR (n:Source)   ON (n.id)
CREATE INDEX FOR (n:Decision) ON (n.id)
CREATE INDEX FOR (n:Incident) ON (n.id)
```

Note: the graph key must exist before `CREATE INDEX` succeeds, so the reset path creates
the graph explicitly (`MERGE (n:ResetMarker {id:0}) DELETE n`) right after a drop.

---

## 2. Node & relationship model

Node labels: `Agent`, `Memory`, `Source`, `Decision`, `Incident`, `AuditEvent`.
(Property tables live in [`README.md` §5](../README.md#5-graph-schema).)

Relationship directions are fixed:

```
(:Agent)-[:CREATED]->(:Memory)
(:Agent)-[:CREATED]->(:Decision)
(:Memory)-[:DERIVED_FROM]->(:Memory)        // child → parent; edge property: evidence (JSON)
(:Memory)-[:SUPPORTED_BY]->(:Source)
(:Decision)-[:DEPENDS_ON]->(:Memory)        // edge property: evidence (JSON)
(:Incident)-[:TARGETS]->(:Memory)
(:Incident)-[:AFFECTS]->(:Decision)
(:Memory)-[:FLAGGED_BY]->(:Incident)        // set by quarantine
(:Decision)-[:FLAGGED_BY]->(:Incident)
(:Incident)-[:HAS_EVENT]->(:AuditEvent)     // quarantine / revalidation audit trail
```

> `backend/src/db/schema.ts` also defines `attachEvidence()` (`(:Incident)-[:EVIDENCE]->(:Evidence)`),
> but it is **not called** by any route — the pipeline stores structured evidence as the
> `Incident.evidence` JSON property. It is listed here only to avoid implying a live edge.

---

## 3. Seeding (idempotent)

`backend/src/services/seed.ts` upserts agents, memories (+ their `Source` and `CREATED`/
`SUPPORTED_BY`/`DERIVED_FROM` edges), decisions (+ `DEPENDS_ON`), and the incident.
Representative write:

```cypher
MERGE (s:Source {id:$sid}) SET s.type=$sourceType, s.description=$sourceDesc, s.trusted=$sourceTrusted, s.synthetic=true
MERGE (mem:Memory {id:$id})
  SET mem.content=$content, mem.status=$status, mem.trust=$trust, mem.createdAt=$createdAt,
      mem.updatedAt=$createdAt, mem.sourceType=$sourceType, mem.sourceRef=$sourceRef,
      mem.reason=$reason, mem.synthetic=true
MERGE (a:Agent {id:$agentId}) SET a.synthetic=true
MERGE (a)-[:CREATED]->(mem)
MERGE (mem)-[:SUPPORTED_BY]->(s)
```

Because every write is keyed on `id`, running the seed any number of times yields the same
graph (verified by the "seed idempotency" test).

---

## 4. Detection & incident creation

When a memory is written, `backend/src/services/detection.ts` runs the deterministic
evaluator (`backend/src/policies/policies.ts`) over `policies.json`. On a triggered
match it persists the incident and its provenance. The incident node uses `CREATE` (new
`inc` UUID per detection); the `TARGETS` edge uses `MERGE` for retry safety:

```cypher
MATCH (m:Memory {id:$mid})
CREATE (i:Incident {
  id:$iid, title:$title, severity:$severity, confidence:$confidence,
  reason:$reason, status:'open', createdAt:$ts, containedAt:null,
  synthetic:true, evidence:$evidence, policyId:$pid
})
MERGE (i)-[t:TARGETS]->(m) ON CREATE SET t.createdAt=$ts
RETURN i.id AS id
```

Affected decisions discovered at detection time are linked with `AFFECTS`
(`WHERE NOT ((i)-[:AFFECTS]->(d))` makes it idempotent):

```cypher
MATCH (i:Incident {id:$iid})
MATCH (d:Decision)-[:DEPENDS_ON*1..6]->(:Memory {id:$mid})
WHERE NOT ( (i)-[:AFFECTS]->(d) )
MERGE (i)-[a:AFFECTS]->(d) ON CREATE SET a.createdAt=$ts,
  a.evidence=$ev
```

The synthetic seed incident uses the equivalent `MERGE` form so re-seeding never duplicates
it (`backend/src/services/seed.ts`, `upsertIncident`).

---

## 5. Blast radius (downstream impact)

Implemented in `backend/src/services/blastRadius.ts`, bounded by `TRAVERSAL` (max depth 6,
max nodes 200; truncation is reported).

**Downstream derived memories** — children that derive from the root (`DERIVED_FROM` is
child→parent, so the pattern reverses the arrow), with the minimum hop depth:

```cypher
MATCH path = (root:Memory {id:$mid})<-[:DERIVED_FROM*1..6]-(m:Memory)
WHERE m.id <> root.id
OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
WITH m, a, min(length(path)) AS depth
ORDER BY depth ASC
LIMIT 200
RETURN m.id AS memoryId, m.content AS content, m.status AS status, a.id AS agentId, depth
```

**Affected decisions** — a decision is affected if it `DEPENDS_ON` the root directly, or any
memory that transitively derives from the root:

```cypher
MATCH (root:Memory {id: $mid})
MATCH (d:Decision)-[:DEPENDS_ON]->(m:Memory)
WHERE m.id = root.id
   OR (m)-[:DERIVED_FROM*1..6]->(root)
RETURN DISTINCT d.id AS decisionId
```

**Influence chains** — end-to-end root → … → decision paths used to render the UI. `*0..6`
includes the zero-hop case (a decision depending directly on the root):

```cypher
MATCH (root:Memory {id: $mid})
MATCH path = (root)<-[:DERIVED_FROM*0..6]-(m:Memory)<-[:DEPENDS_ON]-(d:Decision)
RETURN d.id AS decisionId, [x IN nodes(path) | x.id] AS chain
LIMIT $maxNodes
```

**Exclusion guarantee.** The traversal is the only source of edges; unrelated memories
appear only if a real `DERIVED_FROM`/`DEPENDS_ON` path connects them to the suspect. The
API test `excludes unrelated memories from the blast radius` asserts this.

---

## 6. Quarantine & review propagation

`backend/src/services/containment.ts`.

**(1) Quarantine the targeted suspect memory and contain the incident** (idempotent
`SET`s; `containedAt` is only set once):

```cypher
MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory)
SET m.status='quarantined', m.updatedAt=$ts, m.quarantinedAt=$ts,
    i.status=CASE WHEN i.status IN ['open','investigating'] THEN 'contained' ELSE i.status END,
    i.containedAt=coalesce(i.containedAt, $ts)
RETURN i.id AS incidentId, m.id AS memoryId
```

**(2) Write the containment audit event.** The event id is deterministic
(`eid = "<incidentId>-quarantine"`), so retrying the same quarantine does not create a
second event:

```cypher
MATCH (i:Incident {id:$iid})
MERGE (e:AuditEvent {id:$eid})
  ON CREATE SET e.type='quarantine_applied', e.actor='operator', e.createdAt=$ts, e.reason=$reason
MERGE (i)-[:HAS_EVENT]->(e)
RETURN e.id AS eventId
```

**(3) Flag downstream derived memories `review_required`** (skips already-quarantined ones):

```cypher
MATCH (root:Memory {id:$mid})<-[:DERIVED_FROM*1..6]-(m:Memory)
WHERE m.status IN ['trusted','suspicious']
SET m.status='review_required', m.updatedAt=$ts
RETURN collect(DISTINCT m.id) AS memoryIds
```

**(4) Flag affected decisions `review_required`** (read from the incident's `AFFECTS` edges):

```cypher
MATCH (i:Incident {id:$iid})-[:AFFECTS]->(d:Decision)
WHERE d.status IN ['active','revalidated']
SET d.status='review_required', d.updatedAt=$ts
RETURN collect(DISTINCT d.id) AS decisionIds
```

**(5) Link flagged records back to the incident** for traceability (`FLAGGED_BY`):

```cypher
MATCH (i:Incident {id:$iid}), (m:Memory)
WHERE m.id IN $memIds
MERGE (m)-[f:FLAGGED_BY]->(i) ON CREATE SET f.createdAt=$ts
```

(The decision variant is identical with `(d:Decision)` / `$decIds`.)

The report's `flaggedForReview` / `unresolved` fields are computed from the **persisted**
state after these writes (a fresh `computeBlastRadius` + status read), so repeated
quarantine calls return the same result rather than an empty diff.

---

## 7. Gated revalidation (blocking a dependency)

Ancestor check used before revalidating a `review_required` memory:

```cypher
MATCH (m:Memory {id:$mid})-[:DERIVED_FROM*1..6]->(ancestor:Memory)
WHERE ancestor.status='quarantined'
RETURN collect(DISTINCT ancestor.id) AS ids
```

Decision revalidation is refused (`ok:false` → **HTTP 409**) while any memory in the
decision's `DEPENDS_ON` + `DERIVED_FROM*0..6` closure is `quarantined` **or**
`review_required`:

```cypher
MATCH (d:Decision {id:$did})
OPTIONAL MATCH (d)-[:DEPENDS_ON]->(m:Memory)
OPTIONAL MATCH (m)-[:DERIVED_FROM*0..6]->(ancestor:Memory)
WITH d,
     collect(DISTINCT CASE WHEN ancestor.status IN ['quarantined','review_required'] THEN ancestor.id END) AS blocked
RETURN d.status AS status,
       [x IN blocked WHERE x IS NOT NULL] AS blocked
```

On success, the status change and its audit event are written in a **single** query
(allowing a per-action UUID because the state gate above prevents retries from reaching
this write):

```cypher
MATCH (m:Memory {id:$mid})
OPTIONAL MATCH (m)-[:FLAGGED_BY]->(i:Incident)
WITH m, collect(DISTINCT i) AS incidents
SET m.status='trusted', m.updatedAt=$ts, m.revalidatedAt=$ts, m.revalidationReason=$reason
FOREACH (incident IN incidents |
  MERGE (incident)-[:HAS_EVENT]->(e:AuditEvent {id:$eid})
    ON CREATE SET e.type='memory_revalidated', e.actor=$actor, e.createdAt=$ts, e.reason=$reason
)
RETURN m.id AS id
```

Root revalidation (`POST /api/memories/:id/revalidate?root=true`) is the same shape but
matches `(i:Incident)-[:TARGETS]->(m)` and records `e.type='root_revalidated'`. Decision
revalidation records `e.type='decision_revalidated'` and sets `d.lastValidatedAt`.

**Audit idempotency in one line:** the quarantine event is keyed by incident (one event
forever), while revalidation events are keyed per *successful* action — a retry cannot pass
the state gate, so no duplicate is written. The test
`records distinct review cycles with their own reasons, but creates no retry duplicates`
covers this.

Reading the trail:

```cypher
MATCH (i:Incident {id:$iid})-[:HAS_EVENT]->(e:AuditEvent)
RETURN e.id AS id, e.type AS type, e.actor AS actor, e.reason AS reason, e.createdAt AS createdAt
ORDER BY e.createdAt ASC
```

---

## 8. Graph view (whole graph)

`backend/src/services/graphView.ts` returns the true stored structure (bounded by a
defensive `GRAPH_LIMIT = 1000` rows so the response reports `truncated` honestly). Edges
reference filtered-out node labels (e.g. `AuditEvent`) and are dropped rather than
dangling.

```cypher
MATCH (n)
WHERE labels(n)[0] IN ['Agent','Memory','Source','Decision','Incident']
RETURN labels(n)[0] AS type, n.id AS id,
       coalesce(n.name, n.description, '[' + left(n.content, 60) + '…]') AS name,
       coalesce(n.status, '') AS status,
       coalesce(n.trust, '') AS trust,
       coalesce(n.severity, '') AS severity,
       coalesce(n.role, '') AS role,
       coalesce(n.sourceType, '') AS sourceType,
       n.content AS content
LIMIT $limit
```

```cypher
MATCH (a)-[r]->(b)
RETURN labels(a)[0] AS sourceType, a.id AS sourceId,
       labels(b)[0] AS targetType, b.id AS targetId,
       type(r) AS relType
LIMIT $limit
```

The suspect/attack-path highlight for an incident filter uses bounded expansions:

```cypher
MATCH (root:Memory {id:$mid})<-[:DERIVED_FROM*1..6]-(x:Memory) RETURN DISTINCT x.id AS mid
MATCH (d:Decision)-[:DEPENDS_ON*1..6]->(:Memory {id:$mid}) RETURN DISTINCT d.id AS did
```

---

## 9. Provenance / read queries

Distance-free single-hop lineage for the Memory Explorer (`backend/src/services/memories.ts`):

```cypher
MATCH (m:Memory {id:$id})-[:DERIVED_FROM]->(p:Memory)
RETURN p.id AS id, p.content AS content, p.status AS status ORDER BY p.createdAt
```

Dependent decisions for a root (note `DERIVED_FROM*0..6` includes a direct dependency):

```cypher
MATCH (d:Decision)-[:DEPENDS_ON]->(dependency:Memory)
MATCH (dependency)-[:DERIVED_FROM*0..6]->(root:Memory {id:$id})
RETURN DISTINCT d.id AS id, d.description AS description, d.status AS status
ORDER BY id
```

Evidence paths for the investigation view (`backend/src/services/incidents.ts`):

```cypher
MATCH (i:Incident {id:$id})-[:TARGETS]->(root:Memory)
MATCH path=(root)<-[:DERIVED_FROM*0..6]-(x)
RETURN [n IN nodes(path) | n.id] AS chain
LIMIT 50
```

---

## 10. Boundaries, parameterization & error handling

- **Parameterization** — every value is passed via `$params`. The only interpolated
  fragments are the constants `TRAVERSAL.maxDepth` / `TRAVERSAL.maxNodes` and the index
  label from a fixed literal array; none derive from request input.
- **Bounded traversal** — variable-length matches are capped at depth 6 and results at 200
  nodes (`LIMIT`), with `truncated` surfaced to the caller where applicable.
- **Idempotency** — keyed `MERGE` for nodes/edges; deterministic audit-event ids; status
  transitions guarded by `WHERE` clauses.
- **Error handling** — connection failures are tolerated (`ping` treats FalkorDB's
  "empty key" response as connectivity proof; `dropGraph` tolerates a missing graph).
  Missing records raise `NotFoundError` → HTTP 404; validation failures → HTTP 400;
  malformed JSON bodies → HTTP 400 (not 500); unexpected errors → generic HTTP 500 with
  no stack or credential leakage.
