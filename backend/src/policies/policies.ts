import policiesJsonRaw from './policies.json' with { type: 'json' };

const policiesJson = policiesJsonRaw as { policies: Policy[] };

export type PolicySeverity = 'critical' | 'high' | 'medium' | 'low';
export type PolicyConfidence = 'policy_conflict' | 'signal';

export interface PolicyMatcher {
  type: 'regex';
  field: 'content' | 'sourceType' | 'sourceTrusted';
  pattern: string;
}

export interface Policy {
  id: string;
  title: string;
  statement: string;
  severity: PolicySeverity;
  confidence: PolicyConfidence;
  matchers: PolicyMatcher[];
  unless?: PolicyMatcher[];
}

export const PROTECTED_POLICIES: Policy[] = policiesJson.policies as Policy[];

export interface EvaluationMatch {
  policyId: string;
  matcher: PolicyMatcher;
  excerpt: string;
}

export interface PolicyEvaluation {
  triggered: boolean;
  /** Present only when a policy actually triggered. */
  confidence?: PolicyConfidence;
  policy?: Policy;
  matches: EvaluationMatch[];
  evidenceNote: string;
}

export interface EvaluationInput {
  content: string;
  sourceType: string;
  sourceTrusted: boolean;
}

const COMPILED = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = COMPILED.get(pattern);
  if (!re) {
    re = new RegExp(pattern, 'i');
    COMPILED.set(pattern, re);
  }
  return re;
}

function matcherFields(m: PolicyMatcher, input: EvaluationInput): string | null {
  switch (m.field) {
    case 'content':
      return input.content;
    case 'sourceType':
      return input.sourceType;
    case 'sourceTrusted':
      return String(input.sourceTrusted);
    default:
      return null;
  }
}

/**
 * Deterministic evaluation that avoids relying on blind keyword matching.
 *
 * 1. "Unless" guards are evaluated first: evidence that explicitly documents
 *    approval (e.g. "approved by on-call lead") suppresses the destructive-action rule.
 * 2. All matchers for a policy must hold (AND), combining content signals with
 *    provenance signals (source type / trustedness) where the rule declares them.
 * 3. The result separates *confirmed policy conflicts* from *suspicious signals*,
 *    which downstream code and the UI must not conflate.
 */
export function evaluate(input: EvaluationInput): PolicyEvaluation {
  const policyConflicts: { policy: Policy; matches: EvaluationMatch[] }[] = [];
  const signals: { policy: Policy; matches: EvaluationMatch[] }[] = [];

  for (const policy of PROTECTED_POLICIES) {
    const skipped = (policy.unless ?? []).some((m) => {
      const f = matcherFields(m, input);
      return f !== null && compile(m.pattern).test(f);
    });
    if (skipped) continue;

    const matches: EvaluationMatch[] = [];
    for (const m of policy.matchers) {
      const f = matcherFields(m, input);
      if (f === null) continue;
      const idx = f.search(compile(m.pattern));
      if (idx >= 0) {
        matches.push({ policyId: policy.id, matcher: m, excerpt: f.slice(Math.max(0, idx - 20), idx + 80) });
      }
    }
    if (matches.length === policy.matchers.length && matches.length > 0) {
      (policy.confidence === 'policy_conflict' ? policyConflicts : signals).push({ policy, matches });
    }
  }

  const pick = policyConflicts[0] ?? signals[0];
  if (!pick) {
    return {
      triggered: false,
      matches: [],
      evidenceNote: 'no protected-policy conflict detected',
    };
  }
  return {
    triggered: true,
    confidence: pick.policy.confidence,
    policy: pick.policy,
    matches: pick.matches,
    evidenceNote:
      pick.policy.confidence === 'policy_conflict'
        ? `confirmed conflict with protected policy ${pick.policy.id}`
        : `suspicious signal consistent with heuristic policy ${pick.policy.id}`,
  };
}
