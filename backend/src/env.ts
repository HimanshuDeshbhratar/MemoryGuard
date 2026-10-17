import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 4000),
  falkordbHost: process.env.FALKORDB_HOST ?? '127.0.0.1',
  falkordbPort: Number(process.env.FALKORDB_PORT ?? 6379),
  falkordbGraph: process.env.FALKORDB_GRAPH ?? 'MEMORYGUARD',
  falkordbPassword: process.env.FALKORDB_PASSWORD || undefined,
  // Optional hosted LLM. 'none' = fully deterministic mode (default, no key needed).
  llmProvider: (process.env.LLM_PROVIDER ?? 'none') as
    | 'gemini'
    | 'groq'
    | 'openrouter'
    | 'none',
  llmApiKey: process.env.LLM_API_KEY || undefined,
  llmModel: process.env.LLM_MODEL || undefined, // never hard-coded; must come from env
  llmBaseUrl: process.env.LLM_BASE_URL || undefined,
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // Demo reset is destructive (clears the whole graph). Enabled for local/demo use.
  allowDemoReset: (process.env.ALLOW_DEMO_RESET ?? 'true') === 'true',
} as const;
