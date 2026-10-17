import { roQuery } from '../db/falkordb.js';
import { computeBlastRadius } from './blastRadius.js';

export interface DashboardMetrics {
  memories: {
    total: number;
    trusted: number;
    suspicious: number;
    quarantined: number;
    reviewRequired: number;
  };
  affectedDecisions: number;
  openIncidents: number;
  totalIncidents: number;
  agents: number;
}

export async function dashboardMetrics(): Promise<DashboardMetrics> {
  const memoryRows = await roQuery<{
    total: number;
    trusted: number;
    suspicious: number;
    quarantined: number;
    reviewRequired: number;
  }>(
    `MATCH (m:Memory)
     RETURN count(m) AS total,
            sum(CASE WHEN m.status='trusted' THEN 1 ELSE 0 END) AS trusted,
            sum(CASE WHEN m.status='suspicious' THEN 1 ELSE 0 END) AS suspicious,
            sum(CASE WHEN m.status='quarantined' THEN 1 ELSE 0 END) AS quarantined,
            sum(CASE WHEN m.status='review_required' THEN 1 ELSE 0 END) AS reviewRequired`,
  );
  const m = memoryRows[0] ?? { total: 0, trusted: 0, suspicious: 0, quarantined: 0, reviewRequired: 0 };

  const incidentRows = await roQuery<{ total: number; open: number }>(
    `MATCH (i:Incident)
     RETURN count(i) AS total,
            sum(CASE WHEN i.status IN ['open','investigating'] THEN 1 ELSE 0 END) AS open`,
  );
  const inc = incidentRows[0] ?? { total: 0, open: 0 };

  // Affected = decisions with a transitive DEPENDS_ON path into a suspect memory.
  const incidentSuspects = await roQuery<{ iid: string; mid: string }>(
    'MATCH (i:Incident)-[:TARGETS]->(m:Memory) RETURN i.id AS iid, m.id AS mid',
  );

  const affected = new Set<string>();
  for (const row of incidentSuspects) {
    const blast = await computeBlastRadius(row.iid);
    for (const d of blast.affectedDecisionIds) affected.add(d);
  }

  const agentRows = await roQuery<{ n: number }>('MATCH (a:Agent) RETURN count(a) AS n');

  return {
    memories: {
      total: Number(m.total) || 0,
      trusted: Number(m.trusted) || 0,
      suspicious: Number(m.suspicious) || 0,
      quarantined: Number(m.quarantined) || 0,
      reviewRequired: Number(m.reviewRequired) || 0,
    },
    affectedDecisions: affected.size,
    openIncidents: Number(inc.open) || 0,
    totalIncidents: Number(inc.total) || 0,
    agents: Number(agentRows[0]?.n) || 0,
  };
}

export interface ActivityItem {
  id: string;
  kind: string;
  message: string;
  at: string;
}

export async function recentActivity(limit = 12): Promise<ActivityItem[]> {
  // Derive timeline events from persisted graph facts rather than a separate log:
  // incident creation, memory creation with policy status, derivations, decision
  // dependencies, and audit events (quarantine / revalidation) if present.
  const [incidentRows, memoryRows, auditRows] = await Promise.all([
    roQuery<{ id: string; title: string; status: string; createdAt: string }>(
      `MATCH (i:Incident) RETURN i.id AS id, i.title AS title, i.status AS status, i.createdAt AS createdAt ORDER BY i.createdAt DESC LIMIT $limit`,
      { limit: Math.ceil(limit / 2) },
    ),
    roQuery<{ id: string; status: string; agentId: string; createdAt: string }>(
      `MATCH (a:Agent)-[:CREATED]->(m:Memory)
       RETURN m.id AS id, m.status AS status, a.id AS agentId, m.createdAt AS createdAt
       ORDER BY m.createdAt DESC LIMIT $limit`,
      { limit },
    ),
    roQuery<{ id: string; type: string; reason: string; createdAt: string }>(
      `MATCH (e:AuditEvent) RETURN e.id AS id, e.type AS type, e.reason AS reason, e.createdAt AS createdAt
       ORDER BY e.createdAt DESC LIMIT $limit`,
      { limit: Math.ceil(limit / 2) },
    ),
  ]);

  const items: ActivityItem[] = [];
  for (const r of incidentRows) {
    items.push({
      id: `incident-${r.id}`,
      kind: 'incident_created',
      message: `Incident ${r.status}: ${String(r.title ?? r.id).slice(0, 120)}`,
      at: String(r.createdAt),
    });
  }
  for (const r of memoryRows) {
    items.push({
      id: `memory-${r.id}`,
      kind: 'memory_created',
      message: `Agent ${r.agentId} stored memory ${r.id} (${r.status})`,
      at: String(r.createdAt),
    });
  }
  for (const r of auditRows) {
    items.push({
      id: `audit-${r.id}`,
      kind: r.type || 'audit_event',
      message: String(r.reason || r.id),
      at: String(r.createdAt),
    });
  }
  return items
    .filter((i) => i.at && i.at !== 'null')
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);
}
