import { roQuery } from '../db/falkordb.js';
import { computeBlastRadius } from './blastRadius.js';
import { listIncidentAudit } from './containment.js';
import { parseJsonProp } from '../lib/types.js';

export interface IncidentListItem {
  id: string;
  title: string;
  severity: string;
  status: string;
  createdAt: string;
  confidence: string;
  policyId: string;
  targetsMemoryId: string | null;
  affectedDecisions: number;
  downstreamMemories: number;
  agents: string[];
}

export async function listIncidents(): Promise<IncidentListItem[]> {
  const base = await roQuery<{
    id: string;
    title: string;
    severity: string;
    status: string;
    createdAt: string;
    confidence: string;
    policyId: string;
    targetsMemoryId: string | null;
    affectedDecisions: number;
  }>(
    `MATCH (i:Incident)
     OPTIONAL MATCH (i)-[:TARGETS]->(tm:Memory)
     OPTIONAL MATCH (i)-[:AFFECTS]->(ad:Decision)
     RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
            i.createdAt AS createdAt, coalesce(i.confidence,'policy_conflict') AS confidence,
            coalesce(i.policyId,'') AS policyId, tm.id AS targetsMemoryId,
            count(DISTINCT ad) AS affectedDecisions
     ORDER BY i.createdAt DESC`,
  );

  const items: IncidentListItem[] = [];
  for (const r of base) {
    const agentRows = await roQuery<{ aid: string | null }>(
      `MATCH (i:Incident {id:$iid})-[:TARGETS]->(m:Memory)<-[:CREATED]-(a:Agent)
       RETURN DISTINCT a.id AS aid`,
      { iid: r.id },
    );
    const downstream = await roQuery<{ n: number }>(
      `MATCH (i:Incident {id:$iid})-[:TARGETS]->(root:Memory)
       MATCH path = (root)<-[:DERIVED_FROM*1..6]-(m:Memory)
       RETURN count(DISTINCT m) AS n`,
      { iid: r.id },
    );
    items.push({
      ...r,
      affectedDecisions: Number(r.affectedDecisions) || 0,
      downstreamMemories: Number(downstream[0]?.n) || 0,
      agents: agentRows.map((x) => x.aid).filter((x): x is string => Boolean(x)),
    });
  }
  return items;
}

export interface EvidenceRecord {
  kind: string;
  note: string;
}

export interface IncidentDetail {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
  reason: string;
  createdAt: string;
  containedAt: string | null;
  policyId: string;
  evidence: EvidenceRecord[];
  suspectMemory:
    | {
        id: string;
        content: string;
        status: string;
        sourceType: string;
        sourceRef: string;
        createdAt: string;
        agentId: string | null;
      }
    | null;
  timeline: { id: string; type: string; actor: string; reason: string; createdAt: string }[];
  impact: Awaited<ReturnType<typeof computeBlastRadius>>;
  audit: Awaited<ReturnType<typeof listIncidentAudit>>;
}

export async function getIncident(id: string): Promise<IncidentDetail | null> {
  const rows = await roQuery<{
    id: string;
    title: string;
    severity: string;
    status: string;
    confidence: string;
    reason: string;
    createdAt: string;
    containedAt: string | null;
    policyId: string;
    evidence: string;
  }>(
    `MATCH (i:Incident {id:$id})
     RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
            coalesce(i.confidence,'policy_conflict') AS confidence, i.reason AS reason,
            i.createdAt AS createdAt, i.containedAt AS containedAt,
            coalesce(i.policyId,'') AS policyId, coalesce(i.evidence,'[]') AS evidence`,
    { id },
  );
  if (!rows.length) return null;
  const i = rows[0];

  const suspectRows = await roQuery<{
    id: string;
    content: string;
    status: string;
    sourceType: string;
    sourceRef: string;
    createdAt: string;
    agentId: string | null;
  }>(
    `MATCH (i:Incident {id:$id})-[:TARGETS]->(m:Memory)
     OPTIONAL MATCH (a:Agent)-[:CREATED]->(m)
     RETURN m.id AS id, m.content AS content, m.status AS status, m.sourceType AS sourceType,
            m.sourceRef AS sourceRef, m.createdAt AS createdAt, a.id AS agentId`,
    { id },
  );

  const impact = await computeBlastRadius(id);
  const audit = await listIncidentAudit(id);

  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    confidence: i.confidence,
    reason: i.reason,
    createdAt: String(i.createdAt),
    containedAt: i.containedAt ? String(i.containedAt) : null,
    policyId: i.policyId,
    evidence: parseJsonProp<EvidenceRecord[]>(i.evidence, []) as EvidenceRecord[],
    suspectMemory: suspectRows[0]
      ? {
          ...suspectRows[0],
          createdAt: String(suspectRows[0].createdAt),
        }
      : null,
    timeline: audit,
    impact,
    audit,
  };
}

export async function getIncidentEvidencePaths(id: string): Promise<string[][]> {
  const rows = await roQuery<{ chain: string[] }>(
    `MATCH (i:Incident {id:$id})-[:TARGETS]->(root:Memory)
     MATCH path=(root)<-[:DERIVED_FROM*0..6]-(x)
     RETURN [n IN nodes(path) | n.id] AS chain
     LIMIT 50`,
    { id },
  );
  const unique = new Map<string, string[]>();
  for (const r of rows) unique.set(r.chain.join('>'), r.chain);
  return [...unique.values()];
}
