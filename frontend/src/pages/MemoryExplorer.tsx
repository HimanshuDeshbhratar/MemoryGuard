import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api, timeAgo, shortContent, type MemoryListItem } from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

export default function MemoryExplorer({ onNav, dataVersion }: { onNav: (p: string, id?: string) => void; dataVersion: number }) {
  const [items, setItems] = useState<MemoryListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [agentId, setAgentId] = useState('all');
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .memories({ search: search || undefined, status, agentId, limit: 100 })
        .then((r) => {
          if (!alive) return;
          setItems(r.items);
          setTotal(r.total);
          setError(null);
        })
        .catch((e) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search, status, agentId, dataVersion]);

  if (error) return <ErrorBlock message={error} />;

  return (
    <div>
      <h2 className="page-title">Memory Explorer</h2>
      <p className="page-sub">Persisted memories in FalkorDB with provenance, trust state, and incident associations.</p>

      <div className="filter-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Search size={14} className="dim" />
          <input type="text" placeholder="Search content…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
        </label>
        <label>
          <span>Status&nbsp;</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['all', 'trusted', 'suspicious', 'quarantined', 'review_required'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent&nbsp;</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="all">all agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <span className="faint">{loading ? 'querying…' : `${total} memory${total === 1 ? '' : 'ies'}`}</span>
      </div>

      {loading && !items ? (
        <Loading />
      ) : items && items.length === 0 ? (
        <Empty message="No memories match these filters." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Content</th>
                  <th>Agent</th>
                  <th>Source</th>
                  <th>Trust</th>
                  <th>Created</th>
                  <th>Incidents</th>
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((m) => (
                  <tr key={m.id} className="row-click" onClick={() => onNav('memories', m.id)}>
                    <td className="mono">{m.id}</td>
                    <td className="truncate-note">{shortContent(m.content, 100)}</td>
                    <td className="dim">{m.agentId}</td>
                    <td className="faint">
                      {m.sourceType}
                      {!m.sourceTrusted && ' (untrusted)'}
                    </td>
                    <td>
                      <StatusBadge value={m.status} />
                    </td>
                    <td className="faint">{timeAgo(m.createdAt)}</td>
                    <td>
                      {m.incidentIds.length === 0 ? (
                        <span className="faint">—</span>
                      ) : (
                        m.incidentIds.map((id) => (
                          <button
                            key={id}
                            className="clickable mono"
                            style={{ display: 'block' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onNav('incidents', id);
                            }}
                          >
                            {id}
                          </button>
                        ))
                      )}
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
