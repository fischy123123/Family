import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage, estimateCost } from '@/lib/ai'
import { ATTENTION_MODEL, ATTENTION_MAX_TOKENS, ATTENTION_SYSTEM_PROMPT } from '@/lib/attentionPrompt'

const MODEL = ATTENTION_MODEL

// The Attention Engine + Timeline Intelligence Engine.
// Takes full family context, returns a prioritized "what needs attention now" report.
export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const reqStart = Date.now()
  const ctx: FamilyContextInput & { tier?: 'fast' | 'deep'; suppressedTitles?: string[] } = await request.json()
  // Build context as two parts: the static data block (cacheable) and the
  // dynamic time header (changes every run — not cached).
  const ctxStart = Date.now()
  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)
  console.log(
    `[perf/attention] ctx_build=${Date.now() - ctxStart}ms` +
    ` events=${ctx.events?.length ?? 0} tasks=${ctx.tasks?.length ?? 0}` +
    ` members=${ctx.members?.length ?? 0} inbox=${ctx.inbox?.length ?? 0}` +
    ` prompt_chars=${(timeHeader + dataBlock).length}`
  )

  // Build suppression block from titles the user has explicitly dismissed.
  // This goes into the dynamic (non-cached) part of the prompt so it always
  // reflects the current session's dismissed state without busting the cache.
  const suppressedTitles = ctx.suppressedTitles ?? []
  const suppressionBlock = suppressedTitles.length > 0
    ? `\n\nSUPPRESSED ITEMS (HARD RULE — do NOT include any of these, or anything semantically equivalent, in your output):\n${suppressedTitles.map((t) => `- ${t}`).join('\n')}\nThese are items the user has explicitly dismissed. Re-surfacing them breaks trust.`
    : ''

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Stream the response as newline-delimited JSON events so the client can show
  // the greeting the moment it finishes generating (~2s) instead of waiting for
  // the entire briefing (~20s). Events:
  //   {"t":"delta","d":"<raw text chunk>"}  — incremental model output
  //   {"t":"final", ...report}              — authoritative parsed report
  //   {"t":"error","error":"..."}           — failure (client keeps cached report)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch { /* closed */ }
      }
      try {
        const aiStart = Date.now()
        let ttft = -1
        let chunkCount = 0
        let streamedChars = 0
        const ai = anthropic.messages.stream(
          {
            model: MODEL,
            max_tokens: ATTENTION_MAX_TOKENS,
            // System prompt: static → cache it (saves ~1800 tokens per cache hit).
            // 1-hour TTL (not the 5-min default): briefings run ~15 min apart per
            // the client throttle, and multiple family members load within the
            // same hour, so a 5-min cache almost always expired before the next
            // run. A 1h TTL lets these calls actually hit the cache.
            system: [
              { type: 'text', text: ATTENTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
            ],
            messages: [{
              role: 'user',
              content: [
                // Data block: members, events, tasks, etc. Changes only when the
                // family's actual data changes — cache it (1h) so unchanged data
                // re-reads at 10% cost across the throttle window and between users.
                { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
                // Time header: always fresh — current time + today's date anchor + suppressed items.
                { type: 'text', text: timeHeader + suppressionBlock },
              ],
            }],
          },
          // Abort the upstream model call if the client disconnects, so we don't
          // keep paying for a briefing nobody will see.
          { signal: request.signal },
        )

        ai.on('text', (delta) => {
          if (ttft === -1) {
            ttft = Date.now() - aiStart
            console.log(`[perf/attention] ttft=${ttft}ms (time to first token — when the greeting starts streaming)`)
          }
          chunkCount++
          streamedChars += delta.length
          send({ t: 'delta', d: delta })
        })

        const finalMsg = await ai.finalMessage()
        const aiDone = Date.now()
        const u = finalMsg.usage
        const uMap = u as unknown as Record<string, number>
        const cacheRead = uMap.cache_read_input_tokens ?? 0
        const cacheWrite = uMap.cache_creation_input_tokens ?? 0
        const inTokens = u.input_tokens ?? 0
        const outTokens = u.output_tokens ?? 0

        // ── PERF: generation throughput ──────────────────────────────────────
        // Total AI time splits into: ttft (model reading prompt + first token)
        // and streaming time (generating the rest). Throughput = output tokens
        // per second of streaming — the lever that determines how long a long
        // briefing takes. A low ttft with high total means generation-bound
        // (more output = slower); a high ttft means prompt-bound (big input or
        // cold cache). cache=MISS/WRITE inflates ttft because the model must
        // read the full uncached prompt.
        const totalAi = aiDone - aiStart
        const streamMs = ttft > 0 ? totalAi - ttft : totalAi
        const tokPerSec = streamMs > 0 ? Math.round((outTokens / streamMs) * 1000) : 0
        const cacheStatus = cacheRead > 0 ? 'HIT' : cacheWrite > 0 ? 'WRITE' : 'MISS'

        logUsage('attention', MODEL, finalMsg.usage)
        console.log(
          `[perf/attention] ai_total=${totalAi}ms (ttft=${ttft}ms + stream=${streamMs}ms)` +
          ` throughput=${tokPerSec}tok/s chunks=${chunkCount} streamed_chars=${streamedChars}` +
          ` stop=${finalMsg.stop_reason}`
        )
        // Final summary line — kept last so it's the row preview in Vercel logs.
        console.log(
          `[perf/attention] SUMMARY wall=${aiDone - reqStart}ms ai=${totalAi}ms` +
          ` model=${MODEL} cache=${cacheStatus}` +
          ` in=${inTokens} cr=${cacheRead} cw=${cacheWrite} out=${outTokens} max=6000` +
          ` cost=${estimateCost(MODEL, uMap)}`
        )

        // A truncated JSON isn't useful and shouldn't overwrite the client's
        // existing good report — surface an error so it offers a retry instead.
        if (finalMsg.stop_reason === 'max_tokens') {
          send({ t: 'error', error: 'Briefing was cut short — tap retry to try again.' })
          try { controller.close() } catch { /* noop */ }
          return
        }

        const parseStart = Date.now()
        const text = finalMsg.content[0]?.type === 'text' ? finalMsg.content[0].text : '{}'
        const match = text.match(/\{[\s\S]*\}/)
        let parsed: {
          greeting?: string
          items?: Record<string, unknown>[]
          problems?: Record<string, unknown>[]
          recommendations?: Record<string, unknown>[]
          eventAssignments?: Record<string, unknown>[]
        } = {}
        let parseOk = true
        if (match) {
          try {
            parsed = JSON.parse(match[0])
          } catch {
            parseOk = false
            // Unexpected parse failure (not a token limit issue — already checked).
            // Salvage the greeting so something appears rather than a blank screen.
            const greetingMatch = match[0].match(/"greeting"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/)
            parsed = { greeting: greetingMatch?.[1] ?? 'Here is what needs your attention.', items: [], problems: [], recommendations: [] }
          }
        }

        // Assign stable-ish ids
        const items = (parsed.items ?? []).map((it, i) => ({ id: `att-${i}`, ...it }))
        const problems = (parsed.problems ?? []).map((p, i) => ({ id: `prob-${i}`, ...p }))
        const recommendations = (parsed.recommendations ?? []).map((r, i) => ({ id: `rec-${i}`, ...r }))
        const eventAssignments = (parsed.eventAssignments ?? []).map((a, i) => ({ id: `ea-${i}`, ...a }))

        // ── PERF/OUTPUT: what the model produced and how long parsing took ───
        console.log(
          `[perf/attention] parse=${Date.now() - parseStart}ms parse_ok=${parseOk}` +
          ` → items=${items.length} problems=${problems.length}` +
          ` recommendations=${recommendations.length} eventAssignments=${eventAssignments.length}` +
          ` greeting_chars=${(parsed.greeting ?? '').length}`
        )

        send({
          t: 'final',
          generatedAt: new Date().toISOString(),
          tier: ctx.tier ?? 'fast',
          greeting: parsed.greeting ?? 'Here is what needs your attention.',
          items,
          problems,
          recommendations,
          eventAssignments,
        })
        try { controller.close() } catch { /* noop */ }
      } catch (e: unknown) {
        // Client-initiated aborts are expected (navigation, background) — don't
        // treat them as errors; the client already handles its own abort.
        if (e instanceof Error && e.name === 'AbortError') {
          try { controller.close() } catch { /* noop */ }
          return
        }
        send({ t: 'error', error: e instanceof Error ? e.message : 'Attention engine failed' })
        try { controller.close() } catch { /* noop */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
