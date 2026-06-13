import Anthropic from '@anthropic-ai/sdk'

export const AI_MODEL = 'claude-sonnet-4-6'

export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  return new Anthropic({ apiKey })
}

/**
 * Calls Claude with a prompt and returns the parsed JSON from the response.
 * Strips markdown fences and extracts the first JSON object/array found.
 */
export async function askClaudeJSON<T>(prompt: string, maxTokens = 1500): Promise<T> {
  const anthropic = getAnthropic()
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  // Match the first JSON array or object in the response.
  const match = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
  if (!match) throw new Error('AI did not return valid JSON')
  return JSON.parse(match[0]) as T
}
