export function StatusBadge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  const known = ['trusted', 'suspicious', 'quarantined', 'review_required', 'active', 'revalidated', 'revoked', 'open', 'investigating', 'contained', 'resolved', 'critical', 'high', 'medium', 'low'];
  const cls = known.includes(value) ? value : 'neutral';
  return <span className={`badge ${cls}`}>{value.replace(/_/g, ' ')}</span>;
}

export function IncidentStatusBadge({ value }: { value: string }) {
  return <StatusBadge value={value} />;
}
