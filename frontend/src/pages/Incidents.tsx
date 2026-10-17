import { useEffect, useState } from 'react';
import { api, timeAgo, type IncidentSummary } from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

export default function Incidents({ onNav, dataVersion }: { onNav: (p: string, id?: string) => void; dataVersion: number }) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .incidents()
      .then((r) => alive && setIncidents(r.incidents))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [dataVersion]);

  if (error) return <ErrorBlock message={error} />;
  if (!incidents) return <Loading />;

  return (
    <div>
      <h2 className="page-title">Incidents</h2>
      <p className="page-sub">Persisted incident records from the graph &mdash; each incident targets a suspect memory and tracks containment.</p>
      {incidents.length === 0 ? (
        <Empty message="No incidents. Seed the demo or evaluate a new memory to generate one." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Incident</th>
                  <th>Suspect memory</th>
                  <th>Downstream</th>
                  <th>Detected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id} className="row-click" onClick={() => onNav('incidents', i.id)}>
                    <td>
                      <StatusBadge value={i.severity} />
                    </td>
                    <td style={{ fontWeight: 600 }}>{i.title}</td>
                    <td className="mono">{i.targetsMemoryId}</td>
                    <td className="dim">
                      {i.downstreamMemories} mem · {i.affectedDecisions} dec
                    </td>
                    <td className="faint">{timeAgo(i.createdAt)}</td>
                    <td>
                      <StatusBadge value={i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
