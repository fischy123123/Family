import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage, estimateCost } from '@/lib/ai'
import { ATTENTION_MODEL, ATTENTION_MAX_TOKENS, ATTENTION_SYSTEM_PROMPT } from '@/lib/attentionPrompt'
import { writeDiagnostic } from '@/lib/diagnostics'

const MODEL = ATTENTION_MODEL

// A scoped request asks the model for ONLY one slice of the report. This keeps
// the cached prefix (system prompt + data block) byte-identical across every
// slice, so all the parallel calls share one cache entry — the suffix below is
// appended to the dynamic (uncached) tail. Splitting the work this way lets the
// client fan out concurrent requests and collapse the briefing's wall-time from
// the sum of all output to the length of the single slowest slice.
type EngineScope =
  | { kind: 'items'; sections?: string[]; greeting?: boolean; maxItems?: number }
  // Ownership-scoped slice: route by WHO IS RESPONSIBLE (assigneeEmail), not by
  // who the item is about. 'self' = the signed-in user's plate (things they must
  // handle + their own events); 'others' = everyone else's, surfaced for the
  // user's visibility only. Two of these replace the old per-person shards.
  | { kind: 'plate'; owner: 'self' | 'others'; maxItems?: number }
  | { kind: 'problems' }
  | { kind: 'recommendations' }

function buildScopeSuffix(scope?: EngineScope): string {
  if (!scope) return ''
  if (scope.kind === 'problems') {
    return `\n\nSCOPE OVERRIDE (highest priority — overrides the output shape above): Output ONLY the "problems" array. Your entire response must be a JSON object of exactly this shape: {"problems":[ ... ]}. Do NOT include "greeting", "items", or "recommendations". Apply every "problems" rule from above.

CRITICAL — PROBLEMS = WHAT'S WRONG OR AT RISK (not friendly suggestions): A problem is something BROKEN or in DANGER of breaking that requires the family to fix or verify it: a scheduling conflict or double-booking, an appointment mentioned in email/memory that is NOT on the calendar, a date/time discrepancy between two sources, an overdue or about-to-be-missed obligation, a gap where something needed is missing (no ride arranged, no babysitter for a booked evening event, a prescription running out before a refill). Every problem must name the concrete risk and what is needed to resolve it. Do NOT include optional "nice to have" ideas, comforts, or proactive improvements — those are recommendations, a SEPARATE section, and must never appear here. If nothing is genuinely wrong or at risk, return {"problems":[]}.`
  }
  if (scope.kind === 'recommendations') {
    return `\n\nSCOPE OVERRIDE (highest priority — overrides the output shape above): Output ONLY the "recommendations" array. Your entire response must be a JSON object of exactly this shape: {"recommendations":[ ... ]}. Do NOT include "greeting", "items", or "problems". Apply every "recommendations" rule from above.

CRITICAL — RECOMMENDATIONS ARE NOT PROBLEMS: A recommendation is an OPTIONAL, low-pressure idea that would make life nicer or easier when nothing is actually wrong — an opportunity, a comfort, a smart efficiency, a thoughtful gesture. If something is a risk, conflict, gap, missing calendar entry, or overdue obligation, that is a PROBLEM and belongs in the separate problems section — NEVER surface it here. Examples of GOOD recommendations: "You have a rare free Friday evening — book that dinner you keep mentioning", "Liam's and Maddie's appointments are both near downtown Tuesday — batch the errand you've been putting off into that trip", "Pack Saturday's soccer bag tonight so the morning is calm". Examples of what does NOT belong here (these are problems): "No babysitter for Friday's event", "Therapy not on the calendar", "Task overdue".

CRITICAL — NET-NEW ONLY: The family already SEES their calendar, their open tasks, and the main briefing. A recommendation that restates or "reminds" them of something already on their radar is worthless. Surface only things they have NOT thought of — a second-order consequence, an opportunity hiding in the data, a stress they'd feel later but can defuse now. Quality over quantity: returning {"recommendations":[]} is far better than padding with restated tasks or rephrased problems. Return 0-3, and 0 is the right answer unless you have a genuinely non-obvious, non-problem insight.`
  }
  if (scope.kind === 'plate') {
    const cap = scope.maxItems
      ? ` Return at most ${scope.maxItems} items — prioritise ruthlessly and cut anything below that limit.`
      : ''
    const brevity = ` Your entire response must be a JSON object of exactly this shape: {"items":[ ... ]}. Do NOT include "greeting", "problems", or "recommendations". BREVITY IS CRITICAL: keep each item compact — short title, short reason, omit detail unless essential, omit optional fields when they add no value.`
    if (scope.owner === 'self') {
      return `\n\nSCOPE OVERRIDE (highest priority — overrides the output shape above): Output ONLY items that belong on THE SIGNED-IN USER'S PLATE — the things this specific person is RESPONSIBLE for, plus their own appointments and events.

An item is on the signed-in user's plate when ANY of these is true:
- The signed-in user is the responsible person (the one who must DO it, drive, prepare, decide, attend, or follow up). Set "assigneeEmail" to the signed-in user.
- It is a prep/action the signed-in user must do FOR an upcoming event, EVEN IF that event is about a child or another person (e.g. "iron Maddie's costume tonight", "buy the gift before the ceremony"). These belong on the user's plate because the USER does them — set forEmails to the child but keep this on the user's plate.
- It is the signed-in user's OWN appointment, meeting, or event.
- No responsible adult is clearly assigned and the obligation would fall to the signed-in user by default (an unassigned household obligation defaults to the viewer's plate).

Do NOT include items that another adult or an independent older child is responsible for handling themselves — those go on the OTHER plate (a separate request). When unsure whether the user is truly responsible, INCLUDE it here (better the user sees something they own than misses it).${cap}${brevity}`
    }
    // owner === 'others'
    return `\n\nSCOPE OVERRIDE (highest priority — overrides the output shape above): Output ONLY items that belong on SOMEONE ELSE'S PLATE — things another family member is responsible for, surfaced for the signed-in user's VISIBILITY (awareness, not action).

An item belongs here when the responsible person is SOMEONE OTHER than the signed-in user:
- The other parent/adult is handling it (a pickup, an appointment they drive, a task assigned to them). Set "assigneeEmail" to that responsible person.
- An older child manages it themselves (their own homework, audition video, practice, social plan).

Each item must make the OWNER obvious via "assigneeEmail" (the responsible person) and "section"/"forEmails" (who it's about). Keep these compact and awareness-oriented — the user is scanning to confirm everyone is covered, not to act.

Do NOT include anything the signed-in user must personally do or prepare — that is on the user's own plate, a separate request. Do NOT duplicate the user's own appointments here. If everyone else has nothing noteworthy, return {"items":[]}.${cap}${brevity}`
  }

  // items
  const list = (scope.sections ?? []).map((s) => `"${s}"`).join(', ')
  const sectionsClause = list
    ? ` Include ONLY items whose "section" is one of: [${list}]. Omit every item whose section would be any name not in that list — another concurrent request is responsible for those.`
    : ''
  const greetingClause = scope.greeting ? `"greeting" (following the greeting rules) and ` : ''
  const shape = scope.greeting ? `{"greeting":"...","items":[ ... ]}` : `{"items":[ ... ]}`
  const maxItemsClause = scope.maxItems
    ? ` Return at most ${scope.maxItems} items total across all sections in this request — prioritise ruthlessly and cut anything below that limit.`
    : ''
  return `\n\nSCOPE OVERRIDE (highest priority — overrides the output shape above): Output ONLY ${greetingClause}the "items" array.${sectionsClause}${maxItemsClause} Your entire response must be a JSON object of exactly this shape: ${shape}. Do NOT include "problems" or "recommendations". BREVITY IS CRITICAL: keep each item's JSON compact — short title, short reason, omit detail unless essential, omit optional fields when they add no value.`
}

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
  const ctx: FamilyContextInput & {
    tier?: 'fast' | 'deep'
    suppressedTitles?: string[]
    scope?: EngineScope
  } = await request.json()
  const scope = ctx.scope
  const scopeSuffix = buildScopeSuffix(scope)
  // Build context as two parts: the static data block (cacheable) and the
  // dynamic time header (changes every run — not cached).
  const ctxStart = Date.now()
  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)
  const ctxMs = Date.now() - ctxStart
  const promptChars = (timeHeader + dataBlock).length
  console.log(
    `[perf/attention] ctx_build=${ctxMs}ms` +
    ` events=${ctx.events?.length ?? 0} tasks=${ctx.tasks?.length ?? 0}` +
    ` members=${ctx.members?.length ?? 0} inbox=${ctx.inbox?.length ?? 0}` +
    ` prompt_chars=${promptChars}`
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
      // scopeLabel is also used in the catch block for error diagnostics.
      const scopeLabel = scope
        ? scope.kind === 'items'
          ? `items[${(scope.sections ?? []).join(',') || 'all'}${scope.greeting ? '+greeting' : ''}]`
          : scope.kind === 'plate'
            ? `plate[${scope.owner}]`
            : scope.kind
        : 'full'
      // Per-scope token budget. Items shards need far fewer tokens than a full run
      // (they generate 3-5 compact items, not the entire report). Capping prevents
      // runaway verbose responses (which caused 117s generation in one observed run)
      // and signals to the model to be concise. Problems and recs are even smaller.
      // For a full (unscoped) run, use the shared constant as-is.
      const scopeMaxTokens = !scope
        ? ATTENTION_MAX_TOKENS
        : scope.kind === 'items'
          ? 2000  // 3-5 items at ~100-150 tok each = 300-750 tok; 2000 is a safe ceiling
          : scope.kind === 'problems'
            ? 1200  // max 4 problems at ~200 tok each
            : 800   // max 3 recommendations at ~150 tok each

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
            max_tokens: scopeMaxTokens,
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
                // Time header: always fresh — current time + today's date anchor +
                // suppressed items + (optional) scope override. All of this is the
                // uncached tail, so the cached prefix stays identical across scopes.
                { type: 'text', text: timeHeader + suppressionBlock + scopeSuffix },
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
          const streamedItems = extractCompleteItems(rawSoFar)
          for (let i = emittedItems; i < streamedItems.length; i++) {
            send({ t: 'item', index: i, item: { id: `att-${i}`, ...streamedItems[i] } })
          }
          emittedItems = streamedItems.length
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
          `[perf/attention] SUMMARY scope=${scopeLabel} wall=${aiDone - reqStart}ms ai=${totalAi}ms` +
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

        // Routing-quality signals: how many items carry a responsible person
        // (assigneeEmail) and how many are actions. These reveal from the logs
        // alone whether the self/others plate split is being driven correctly.
        const assignedCount = items.filter((it) => {
          const a = (it as Record<string, unknown>).assigneeEmail
          return typeof a === 'string' && a.trim().length > 0
        }).length
        const actionCount = items.filter((it) => (it as Record<string, unknown>).kind === 'action').length

        // Persist structured diagnostics to Firestore — fire-and-forget.
        writeDiagnostic({
          ts: aiDone, scope: scopeLabel,
          email: ctx.currentUserEmail ?? 'unknown',
          events: ctx.events?.length ?? 0, tasks: ctx.tasks?.length ?? 0,
          members: ctx.members?.length ?? 0, inbox: ctx.inbox?.length ?? 0,
          prompt_chars: promptChars, ctx_ms: ctxMs,
          ttft_ms: ttft, ai_ms: totalAi, wall_ms: aiDone - reqStart,
          in_tokens: inTokens, out_tokens: outTokens,
          cache_read: cacheRead, cache_write: cacheWrite,
          cache_status: cacheStatus, tok_per_sec: tokPerSec,
          items: items.length, problems: problems.length, recs: recommendations.length,
          assigned: assignedCount, actions: actionCount,
          parse_ok: parseOk, stop_reason: finalMsg.stop_reason ?? 'unknown',
        })

        // ── PERF/OUTPUT: what the model produced and how long parsing took ───
        console.log(
          `[perf/attention] parse=${Date.now() - parseStart}ms parse_ok=${parseOk}` +
          ` → items=${items.length} (assigned=${assignedCount} actions=${actionCount})` +
          ` problems=${problems.length} recommendations=${recommendations.length}` +
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
        const errMsg = e instanceof Error ? e.message : 'Attention engine failed'
        writeDiagnostic({
          ts: Date.now(), scope: scopeLabel ?? 'unknown',
          email: ctx.currentUserEmail ?? 'unknown',
          events: ctx.events?.length ?? 0, tasks: ctx.tasks?.length ?? 0,
          members: ctx.members?.length ?? 0, inbox: ctx.inbox?.length ?? 0,
          prompt_chars: promptChars, ctx_ms: ctxMs,
          ttft_ms: -1, ai_ms: -1, wall_ms: Date.now() - reqStart,
          in_tokens: 0, out_tokens: 0, cache_read: 0, cache_write: 0,
          cache_status: 'MISS', tok_per_sec: 0,
          items: 0, problems: 0, recs: 0, assigned: 0, actions: 0, parse_ok: false,
          stop_reason: 'error', error: errMsg,
        })
        send({ t: 'error', error: errMsg })
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
