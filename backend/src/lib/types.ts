export type MemoryStatus = 'trusted' | 'suspicious' | 'quarantined' | 'review_required';
export type DecisionStatus = 'active' | 'review_required' | 'revalidated' | 'revoked';
export type IncidentStatus = 'open' | 'investigating' | 'contained' | 'resolved';
export type TrustLabel = 'trusted' | 'untrusted';

/** Bounded traversal limits (prevent unbounded expansion). */
export const TRAVERSAL = {
  maxDepth: 6,
  maxNodes: 200,
} as const;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function truncate(text: unknown, max = 160): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function toJsonProp(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonProp<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') {
    // FalkorDB may return JSON strings parsed back into objects already.
    try {
      return value as T;
    } catch {
      return fallback;
    }
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
