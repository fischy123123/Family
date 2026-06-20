import Anthropic from '@anthropic-ai/sdk'

// Tiered models — pick per task by what it actually needs:
// - FAST (Haiku): high-volume / latency-sensitive / structured extraction.
// - BALANCED (Sonnet): interactive chat and general generation.
// - DEEP (Opus): low-frequency, high-value reasoning (planning, deep prioritization).
export const MODEL_FAST = 'claude-haiku-4-5-20251001'
export const MODEL_BALANCED = 'claude-sonnet-4-6'
export const MODEL_DEEP = 'claude-opus-4-8'

// Back-compat default for callers that don't specify a tier.
export const AI_MODEL = MODEL_BALANCED

export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  return new Anthropic({ apiKey })
}

// Per-model pricing in $ per 1M tokens: [input, cacheWrite, cacheRead, output]
const MODEL_PRICING: Record<string, [number, number, number, number]> = {
  'claude-opus-4-8':           [5.00, 6.25, 0.50, 25.00],
  'claude-sonnet-4-6':         [3.00, 3.75, 0.30, 15.00],
  'claude-haiku-4-5-20251001': [1.00, 1.25, 0.10,  5.00],
  'claude-haiku-4-5':          [1.00, 1.25, 0.10,  5.00],
}

export function estimateCost(model: string, u: Record<string, number>): string {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return '?'
  const [pIn, pCw, pCr, pOut] = pricing
  const cost =
    (u.input_tokens ?? 0)                * pIn  / 1_000_000 +
    (u.cache_creation_input_tokens ?? 0) * pCw  / 1_000_000 +
    (u.cache_read_input_tokens ?? 0)     * pCr  / 1_000_000 +
    (u.output_tokens ?? 0)               * pOut / 1_000_000
  return `$${cost.toFixed(4)}`
}

// Centralized usage logging. Grep Vercel logs for "[ai-usage]" to see spend
// per route and model. Example:
//   [ai-usage] route=attention model=claude-sonnet-4-6 in=850 cw=0 cr=4200 out=320 cost=$0.0062
// in=uncached input tokens (full price)
// cw=cache write tokens (1.25x input price, paid once to populate cache)
// cr=cache read tokens (0.1x input price — the saving)
// out=output tokens (most expensive per token)
export function logUsage(route: string, model: string, usage: unknown) {
  const u = (usage ?? {}) as Record<string, number>
  console.log(
    `[ai-usage] route=${route} model=${model} ` +
    `in=${u.input_tokens ?? 0} cw=${u.cache_creation_input_tokens ?? 0} ` +
    `cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
    `cost=${estimateCost(model, u)}`
  )
}

/**
 * Calls Claude with a prompt and returns the parsed JSON from the response.
 * Strips markdown fences and extracts the first JSON object/array found.
 * Pass `model` to override the default (e.g. MODEL_FAST for cheap extraction).
 * Pass `route` to tag the usage log so we can attribute spend per feature.
 */
export async function askClaudeJSON<T>(
  prompt: string,
  maxTokens = 1500,
  model: string = AI_MODEL,
  route = 'askClaudeJSON',
): Promise<T> {
  const anthropic = getAnthropic()
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  logUsage(route, model, response.usage)

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  // Match the first JSON array or object in the response.
  const match = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
  if (!match) throw new Error('AI did not return valid JSON')
  return JSON.parse(match[0]) as T
}
