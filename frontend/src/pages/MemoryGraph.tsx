import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type GraphNode as ApiNode, type GraphEdge as ApiEdge } from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

const ROLE_COLORS: Record<string, string> = {
  Agent: '#5b8cff',
  Memory_trusted: '#3ecf8e',
  Memory_suspicious: '#f5b950',
  Memory_quarantined: '#f6667a',
  Memory_review_required: '#b18bff',
  Decision: '#5b8cff',
  Source: '#8b93a7',
  Incident: '#f6667a',
};

function FlowNode({ node, selected, onOpen }: { node: ApiNode; selected: boolean; onOpen: (n: ApiNode) => void }) {
  const key = node.status ? `${node.type}_${node.status}` : node.type;
  const color = ROLE_COLORS[key] ?? ROLE_COLORS[node.type] ?? '#2e374a';
  return (
    <div
      className={`flow-node ${node.type} ${node.status ?? ''} ${selected ? 'selected' : ''}`}
      onClick={() => onOpen(node)}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      {/* Invisible connection anchors; edges draw node-to-node */}
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} isConnectable={false} />
      <div className="ntype">{node.type}</div>
      <div className="nlabel">{node.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} isConnectable={false} />
    </div>
  );
}

export default function MemoryGraph({ onNav, dataVersion }: { onNav: (p: string, id?: string) => void; dataVersion: number }) {
  const [nodes, setNodes] = useState<ApiNode[] | null>(null);
  const [edges, setEdges] = useState<ApiEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiNode | null>(null);

  // filters
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [agentId, setAgentId] = useState('all');
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setNodes(null);
    api
      .graph({ type, status, agentId })
      .then((v) => {
        if (!alive) return;
        setNodes(v.nodes);
        setEdges(v.edges);
        setError(null);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [type, status, agentId, dataVersion]);

  const flowNodes = useMemo<Node[]>(
    () =>
      (nodes ?? []).map((n) => ({
        id: n.id,
        data: { n },
        position: { x: (hashOf(n.id) % 9) * 150, y: (depthHash(n.id, n.type) % 6) * 130 },
        type: 'customNode' as const,
      })),
    [nodes],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      (edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.type,
        type: 'default' as const,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed as const, color: '#3a4256' },
        style: { stroke: '#3a4256' },
        labelShowBg: true,
        labelBgStyle: { fill: '#11151f' },
        labelStyle: { fill: '#5d6577', fontSize: 9 },
      })),
    [edges],
  );

  const [reactFlowNodes, setReactFlowNodes] = useState<Node[]>([]);
  const [nodeTypes] = useState(() => ({
    customNode: ({ data, selected }: { data: { n: ApiNode }; selected: boolean }) => (
      <FlowNode node={data.n} selected={selected} onOpen={setSelected} />
    ),
  }));

  useEffect(() => {
    setReactFlowNodes(flowNodes);
  }, [flowNodes]);

  async function onNodeClickNode(_e: unknown, node: Node) {
    const n = (node.data as { n: ApiNode }).n;
    setSelected(n);
  }

  if (error) return <ErrorBlock message={`Graph query failed: ${error}`} />;

  return (
    <div>
      <h2 className="page-title">Memory Graph</h2>
      <p className="page-sub">
        Live graph from FalkorDB. Edges are real stored relationships (CREATED, DERIVED_FROM, SUPPORTED_BY, DEPENDS_ON,
        TARGETS, AFFECTS) &mdash; the frontend never invents edges.
      </p>

      <div className="graph-toolbar">
        <label>
          <div className="faint">Node type</div>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {['all', 'Agent', 'Memory', 'Source', 'Decision', 'Incident'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <div className="faint">Trust status</div>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['all', 'trusted', 'suspicious', 'quarantined', 'review_required'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <div className="faint">Agent</div>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="all">all agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>

      {!nodes && <Loading label="Loading graph…" />}
      {nodes && nodes.length === 0 && (
        <div className="card">
          <Empty message="No nodes match the current filters. Reset the filters or reseed the demo from Overview." />
        </div>
      )}
      {nodes && nodes.length > 0 && (
        <div style={{ display: 'flex', gap: 14, minHeight: 460, height: 'calc(100vh - 300px)' }}>
          <div className="graph-box" style={{ flex: 1 }}>
            <ReactFlow
              nodes={reactFlowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes as never}
              onNodeClick={onNodeClickNode}
              fitView
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1c2230" gap={18} />
              <Controls />
              <MiniMap nodeColor={() => '#2e374a'} maskColor="rgba(11,14,20,0.8)" pannable />
            </ReactFlow>
          </div>

          <div className="card graph-panel">
            {selected ? (
              <>
                <h3>Node details</h3>
                <div className="kv" style={{ gridTemplateColumns: '90px 1fr' }}>
                  <dt>Type</dt>
                  <dd>{selected.type}</dd>
                  <dt>ID</dt>
                  <dd>{selected.id}</dd>
                  {selected.status && (
                    <>
                      <dt>Status</dt>
                      <dd>
                        <StatusBadge value={selected.status} />
                      </dd>
                    </>
                  )}
                  {selected.agentId && (
                    <>
                      <dt>Agent scope</dt>
                      <dd>{selected.agentId}</dd>
                    </>
                  )}
                </div>
                {typeof selected.props?.content === 'string' && (
                  <p style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{selected.props.content}</p>
                )}
                {(selected.type === 'Memory' || selected.id.startsWith('mem-')) && (
                  <button className="btn small" onClick={() => onNav('memories', selected.id)} style={{ marginTop: 8 }}>
                    Open memory detail →
                  </button>
                )}
              </>
            ) : (
              <Empty message="Click a node to inspect its properties." />
            )}

            <div className="lib-note">Legend</div>
            <div className="legend">
              {[
                ['Agent', '#5b8cff'],
                ['Trusted memory', '#3ecf8e'],
                ['Suspicious', '#f5b950'],
                ['Quarantined', '#f6667a'],
                ['Review required', '#b18bff'],
                ['Source', '#8b93a7'],
                ['Incident', '#f6667a'],
              ].map(([label, color]) => (
                <span key={label} className="legend-item">
                  <span className="legend-swatch" style={{ background: color, borderColor: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return h;
}

/**
 * Layout hint only: prefer vertical placement by relationship depth so chains
 * read top-down. Purely cosmetic — positions never affect data.
 */
function depthHash(id: string, type: string): number {
  const pos: Record<string, number> = { Incident: 0, Agent: 1, Source: 2, Memory: 3, Decision: 4 };
  const base = pos[type] ?? 3;
  const depthWord = /(mem-|dec-|source-)(\d)/.exec(id);
  let extra = 0;
  if (depthWord) extra = Number(depthWord[2]) % 3;
  return base + extra;
}
