import { useState, useEffect } from 'react';
import { api, shortContent, type MemoryDetail as MemoryDetailType } from '../lib/api';
import { StatusBadge } from '../components/badges';
import { Loading, ErrorBlock } from '../components/states';

export default function MemoryDetail({ id, onNav }: { id: string; onNav: (page: string, param?: string) => void }) {
  const [detail, setDetail] = useState<MemoryDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .memory(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message ?? String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) return <ErrorBlock message={error} />;
  if (!detail) return <Loading label="Loading memory…" />;
  const m = detail.memory;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => onNav('memories')}>
          ← Back to explorer
        </button>
        <span className="mono dim">{m.id}</span>
        <StatusBadge value={m.status} />
        <span className="badge neutral">trust: {m.trust}</span>
        <span className="badge neutral">source: {m.sourceType}{m.sourceTrusted ? '' : ' (untrusted)'}</span>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Content</h3>
          <div className="quoted-memory">{m.content}</div>
          <div className="kv" style={{ marginTop: 12 }}>
            <dt>Created by</dt>
            <dd>{detail.createdAtBy ? `${detail.createdAtBy.name} (${detail.createdAtBy.id})` : m.agentId}</dd>
            <dt>Provenance</dt>
            <dd>{m.reason || '—'}</dd>
            <dt>Source</dt>
            <dd>
              {detail.supportingSources.length === 0
                ? '—'
                : detail.supportingSources.map((s) => `${s.id} · ${s.description || s.type} · trusted=${String(s.trusted)}`)}
            </dd>
            <dt>Created</dt>
            <dd>{m.createdAt}</dd>
            <dt>Updated</dt>
            <dd>{m.updatedAt}</dd>
            <dt>Incidents</dt>
            <dd>
              {m.incidents.length === 0
                ? '—'
                : m.incidents.map((i) => (
                    <button key={i} className="clickable mono" style={{ display: 'block' }} onClick={() => onNav('incidents', i)}>
                      {i}
                    </button>
                  ))}
            </dd>
          </div>
        </div>

        <div className="card">
          <h3>Lineage (graph-derived)</h3>
          <div className="faint" style={{ marginBottom: 4 }}>Derived from</div>
          <div className="detail-list">
            {detail.derivedFrom.length === 0 && <span className="dim">None — root memory.</span>}
            {detail.derivedFrom.map((p) => (
              <div key={p.id} className="card" style={{ padding: 10 }}>
                <span className="mono">{p.id}</span> <StatusBadge value={p.status} />
                <div className="dim" style={{ fontSize: 12.5 }}>{shortContent(p.content, 160)}</div>
              </div>
            ))}
          </div>

          <div className="faint" style={{ marginTop: 12, marginBottom: 4 }}>Derived memories</div>
          <div className="detail-list">
            {detail.derivedMemories.length === 0 && <span className="dim">None.</span>}
            {detail.derivedMemories.map((c) => (
              <div key={c.id} className="card" style={{ padding: 10 }}>
                <span className="mono">{c.id}</span> <StatusBadge value={c.status} />
                <div className="dim" style={{ fontSize: 12.5 }}>{shortContent(c.content, 160)}</div>
              </div>
            ))}
          </div>

          <div className="faint" style={{ marginTop: 12, marginBottom: 4 }}>Dependent decisions</div>
          <div className="detail-list">
            {detail.dependentDecisions.length === 0 && <span className="dim">None.</span>}
            {detail.dependentDecisions.map((d) => (
              <div key={d.id} className="card" style={{ padding: 10 }}>
                <span className="mono">{d.id}</span> <StatusBadge value={d.status} />
                <div className="dim" style={{ fontSize: 12.5 }}>{d.description}</div>
              </div>
            ))}
          </div>

          <div className="faint" style={{ marginTop: 12, marginBottom: 4 }}>
            Observed exposure — unproven (retrieved in a context this record was written in)
          </div>
          <div className="detail-list">
            {detail.exposedTo.length === 0 && <span className="dim">None recorded.</span>}
            {detail.exposedTo.map((e) => (
              <div key={e.id} className="card" style={{ padding: 10, borderLeft: '3px dashed var(--amber, #f5b950)' }}>
                <span className="mono">{e.id}</span> <StatusBadge value={e.status} />
                {e.contextId && <span className="faint"> · context {e.contextId}</span>}
                <div className="dim" style={{ fontSize: 12.5 }}>{shortContent(e.content, 160)}</div>
              </div>
            ))}
          </div>

          <div className="faint" style={{ marginTop: 12, marginBottom: 4 }}>
            Records written while exposed to this memory (potential influence)
          </div>
          <div className="detail-list">
            {detail.exposedRecords.length === 0 && <span className="dim">None recorded.</span>}
            {detail.exposedRecords.map((r) => (
              <div key={r.id} className="card" style={{ padding: 10, borderLeft: '3px dashed var(--amber, #f5b950)' }}>
                <span className="mono">{r.id}</span> <span className="badge neutral">{r.kind}</span>
                <div className="dim" style={{ fontSize: 12.5 }}>{shortContent(r.label, 160)}</div>
              </div>
            ))}
          </div>

          <div className="faint" style={{ marginTop: 12 }}>
            {detail.createdInContexts.length === 0
              ? 'Provenance coverage: unknown — this record has no recorded retrieval context or declared lineage. Absence of recorded paths is not proof of absence of influence.'
              : `Written in context(s): ${detail.createdInContexts.join(', ')}`}
          </div>
        </div>
      </div>
    </div>
  );
}
