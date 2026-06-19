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

// Centralized usage logging so every Claude call reports its token cost with a
// route tag. Grep Vercel logs for "[ai-usage]" to see which routes dominate the
// bill, e.g.:
//   [ai-usage] route=gmail-suggestions model=claude-haiku... in=12043 cw=0 cr=0 out=842
// in=uncached input, cw=cache write, cr=cache read, out=output.
export function logUsage(route: string, model: string, usage: unknown) {
  const u = (usage ?? {}) as Record<string, number>
  console.log(
    `[ai-usage] route=${route} model=${model} ` +
    `in=${u.input_tokens ?? 0} cw=${u.cache_creation_input_tokens ?? 0} ` +
    `cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0}`
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
