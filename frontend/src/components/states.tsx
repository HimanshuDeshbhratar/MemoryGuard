import { AlertTriangle, Inbox } from 'lucide-react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state-block">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="error-banner">
      <AlertTriangle size={15} />
      {message}
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return (
    <div className="state-block">
      <Inbox size={26} style={{ margin: '0 auto 10px', color: 'var(--text-faint)' }} />
      {message}
    </div>
  );
}
