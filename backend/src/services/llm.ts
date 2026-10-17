import { z } from 'zod';
import { env } from '../env.js';
import { getIncident, type IncidentDetail } from './incidents.js';

/**
 * Optional hosted-LLM adapter. The core security workflow is deterministic and
 * never depends on the LLM: explanations are advisory only. The model is chosen
 * via env (LLM_MODEL); no model ids or keys are ever hard-coded.
 */

export interface ExplanationSource {
  source: 'llm' | 'deterministic';
  provider: string;
  model: string | null;
}

export interface IncidentExplanation extends ExplanationSource {
  summary: string;
  whyTriggered: string;
  dependencyChainSummary: string;
  remediation: string[];
  confidenceNote: string;
}

const ExplanationSchema = z.object({
  summary: z.string().min(1).max(2000),
  whyTriggered: z.string().min(1).max(2000),
  dependencyChainSummary: z.string().min(1).max(2000),
  remediation: z.array(z.string().min(1).max(500)).min(1).max(8),
});

function incidentFacts(i: IncidentDetail): string {
  return [
    `Incident ${i.id}: "${i.title}" (severity ${i.severity}, confidence ${i.confidence})`,
    `Reason: ${i.reason}`,
    i.suspectMemory
      ? `Suspect memory ${i.suspectMemory.id} (status ${i.suspectMemory.status}, source ${i.suspectMemory.sourceType}):\n${i.suspectMemory.content}`
      : 'No suspect memory linked.',
    `Downstream memories: ${i.impact.downstreamMemoryIds.join(', ') || 'none'}`,
    `Affected decisions: ${i.impact.affectedDecisionIds.join(', ') || 'none'}`,
    `Dependency chains: ${i.impact.chains.map((c) => c.chain.join(' -> ')).join(' | ') || 'none'}`,
  ].join('\n');
}

/** Deterministic, zero-cost explanation — always available. */
function deterministicExplanation(i: IncidentDetail): IncidentExplanation {
  const chainText = i.impact.chains.length
    ? i.impact.chains
        .map(
          (c) =>
            `${c.chain.join(' -> ')}${c.decisionId ? ` -> decision ${c.decisionId}` : ''}`,
        )
        .join('; ')
    : 'the suspect memory has no derived memories or dependent decisions yet';

  return {
    source: 'deterministic',
    provider: 'deterministic',
    model: null,
    summary: `Incident "${i.title}" was opened because a stored memory conflicts with protected policy ${i.policyId || '(recorded at detection)'}.`,
    whyTriggered: i.reason,
    dependencyChainSummary: chainText,
    remediation: i.impact.downstreamMemoryIds.length
      ? [
          'Confirm quarantine of the suspect memory.',
          `Review each derived memory flagged for review: ${i.impact.downstreamMemoryIds.join(', ')}.`,
          'Revalidate affected decisions only after their dependencies are reviewed.',
        ]
      : ['Review the suspect memory and either revalidate it or keep it quarantined.'],
    confidenceNote:
      i.confidence === 'signal'
        ? 'This is a suspicious signal (heuristic), not a confirmed policy conflict.'
        : 'This is a confirmed conflict with a protected policy.',
  };
}

async function callOpenAiCompatible(
  prompt: string,
  system: string,
): Promise<string> {
  const base = env.llmBaseUrl ?? 'https://openrouter.ai/api/v1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.llmTimeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.llmApiKey}`,
      },
      body: JSON.stringify({
        model: env.llmModel, // required from env; never hard-coded
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error('LLM rate limited');
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned no content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `You are a security-analyst assistant summarizing a memory-integrity incident.
You receive only the retrieved evidence below. You must not invent graph edges,
records, or facts. Base every statement only on the provided evidence.
Respond with JSON: {"summary": string, "whyTriggered": string, "dependencyChainSummary": string, "remediation": string[]}`;

export async function explainIncident(incidentId: string): Promise<IncidentExplanation | null> {
  const incident = await getIncident(incidentId);
  if (!incident) return null;

  if (
    env.llmProvider !== 'none' &&
    env.llmApiKey &&
    env.llmModel &&
    (env.llmProvider !== 'gemini' || env.llmBaseUrl) // gemini via OpenAI-compatible proxy only
  ) {
    try {
      const raw = await callOpenAiCompatible(incidentFacts(incident), SYSTEM_PROMPT);
      const parsed = ExplanationSchema.parse(JSON.parse(raw));
      return {
        source: 'llm',
        provider: env.llmProvider,
        model: env.llmModel,
        summary: parsed.summary,
        whyTriggered: parsed.whyTriggered,
        dependencyChainSummary: parsed.dependencyChainSummary,
        remediation: parsed.remediation,
        confidenceNote: explanationConfidenceNote(incident),
      };
    } catch {
      // Graceful fallback: any LLM failure (rate limit, timeout, bad output) falls
      // through to the deterministic explanation.
    }
  }
  return deterministicExplanation(incident);
}

function explanationConfidenceNote(i: IncidentDetail): string {
  return i.confidence === 'signal'
    ? 'This is a suspicious signal (heuristic), not a confirmed policy conflict. LLM text is advisory only.'
    : 'This is a confirmed conflict with a protected policy. LLM text is advisory only.';
}
