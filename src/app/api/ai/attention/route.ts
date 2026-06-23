import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage, estimateCost } from '@/lib/ai'
import { ATTENTION_MODEL, ATTENTION_MAX_TOKENS, ATTENTION_SYSTEM_PROMPT } from '@/lib/attentionPrompt'

const MODEL = ATTENTION_MODEL

// Incrementally pull COMPLETE item objects out of the still-streaming JSON so we
// can emit each card the instant the model finishes writing it — instead of
// making the user wait for the entire document to parse. Returns every
// fully-closed object inside the top-level "items" array found so far. This is
// the array-of-objects analogue of the client's extractPartialGreeting.
function extractCompleteItems(raw: string): Record<string, unknown>[] {
  const key = raw.indexOf('"items"')
  if (key === -1) return []
  const arrOpen = raw.indexOf('[', key)
  if (arrOpen === -1) return []

  const out: Record<string, unknown>[] = []
  let depth = 0          // object-brace nesting depth within the array
  let objStart = -1      // index where the current top-level object began
  let inStr = false
  let escaped = false

  for (let i = arrOpen + 1; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) objStart = i; depth++; continue }
    if (c === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        try { out.push(JSON.parse(raw.slice(objStart, i + 1))) } catch { /* skip malformed */ }
        objStart = -1
      }
      continue
    }
    if (c === ']' && depth === 0) break  // items array closed — nothing more to extract
  }
  return out
}

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
      // Flush a padding line + an "open" event immediately, before the slow AI
      // call. This forces the connection open and pushes past any byte-threshold
      // buffering in the proxy, so subsequent token events stream in real time
      // instead of being held until the response completes. The client ignores
      // unknown event types and skips blank/comment lines.
      try {
        controller.enqueue(encoder.encode(':' + ' '.repeat(2048) + '\n'))
        send({ t: 'open' })
      } catch { /* closed */ }
      console.log(`[perf/attention] pre_ai=${Date.now() - reqStart}ms — request parsed + context built, starting Anthropic call`)
      try {
        const aiStart = Date.now()
        let ttft = -1
        let chunkCount = 0
        let streamedChars = 0
        // Accumulated model text + how many items we've already pushed as cards,
        // so the text handler can emit each newly-completed item exactly once.
        let rawSoFar = ''
        let emittedItems = 0
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

          // Progressive cards: as soon as the model closes an item object, ship
          // it so the client can render that card immediately. The greeting comes
          // first in the JSON, so by the time items appear it has already streamed.
          rawSoFar += delta
          const items = extractCompleteItems(rawSoFar)
          for (let i = emittedItems; i < items.length; i++) {
            send({ t: 'item', index: i, item: { id: `att-${i}`, ...items[i] } })
          }
          emittedItems = items.length
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
          ` in=${inTokens} cr=${cacheRead} cw=${cacheWrite} out=${outTokens} max=${ATTENTION_MAX_TOKENS}` +
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

        // ── PERF/OUTPUT: what the model produced and how long parsing took ───
        console.log(
          `[perf/attention] parse=${Date.now() - parseStart}ms parse_ok=${parseOk}` +
          ` → items=${items.length} problems=${problems.length}` +
          ` recommendations=${recommendations.length}` +
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
      // Defeat proxy/CDN buffering so NDJSON events reach the browser as they're
      // produced. Without this, Vercel/nginx hold the whole response and flush it
      // at the end — the user sees a blank screen for the full generation, then
      // everything at once. X-Accel-Buffering disables nginx-style buffering;
      // the upfront padding flush (see stream start) defeats byte-threshold
      // buffering before the slow AI call begins.
      'X-Accel-Buffering': 'no',
    },
  })
}
