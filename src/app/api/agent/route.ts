import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { generateId } from '@/lib/utils'
import {
  TOOLS,
  WRITE_TOOLS,
  buildSystemPrompt,
  executeTool,
  type ToolContext,
  type PendingAction,
} from '@/lib/agent/tools'
import type { FamilyMember, FamilyMemory, FamilyProfile } from '@/lib/types'
import { logUsage, estimateCost } from '@/lib/ai'

const AI_MODEL = 'claude-sonnet-4-6'

// ---------------------------------------------------------------------------
// Streaming SSE agent route — PROPOSE phase
//
// Read tools run live so the AI can gather context. Write tools are NOT
// executed; instead each one is captured as a "pending action" and a synthetic
// "queued" tool result is fed back so the AI can finish its turn and summarize
// what it intends to do. The client then shows a confirmation card, and on
// approval calls /api/agent/execute to actually apply the actions.
//
// Response format: text/event-stream (SSE)
//   data: {"type":"token","token":"..."}\n\n   — streaming text delta
//   data: {"type":"done","reply":"...","pendingActions":[...],"actions":[...]}\n\n
//   data: {"type":"error","error":"..."}\n\n
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder()

  // Set up the SSE stream immediately so the client receives headers right away.
  let enqueue: (chunk: Uint8Array) => void = () => {}
  let closeStream: () => void = () => {}

  const stream = new ReadableStream({
    start(controller) {
      enqueue = (chunk) => {
        try { controller.enqueue(chunk) } catch { /* stream already closed */ }
      }
      closeStream = () => {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })

  function send(event: Record<string, unknown>) {
    enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  }

  // Run the async agent work in the background; the stream is returned immediately.
  ;(async () => {
    try {
      const { messages, familyId, userEmail, googleTokens, context } = await request.json()

      if (!familyId) {
        send({ type: 'error', error: 'familyId is required' })
        closeStream()
        return
      }

      let db: FirebaseFirestore.Firestore | null = null
      try {
        const adminApp = getAdminApp()
        if (adminApp) db = getFirestore(adminApp)
      } catch { /* db stays null */ }

      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        send({ type: 'error', error: 'ANTHROPIC_API_KEY not configured' })
        closeStream()
        return
      }
      const anthropic = new Anthropic({ apiKey })

      const members: FamilyMember[] = context?.members ?? []
      const today: string = context?.today ?? new Date().toISOString()
      const timezone: string | undefined = context?.timezone

      let memories: FamilyMemory[] = []
      let profile: FamilyProfile | null = null
      if (db) {
        try {
          const famRef = db.collection('families').doc(familyId)
          const [memSnap, profSnap] = await Promise.all([
            famRef.collection('memories').get(),
            famRef.collection('profile').get(),
          ])
          memories = memSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FamilyMemory)
          profile = profSnap.docs[0] ? ({ id: profSnap.docs[0].id, ...profSnap.docs[0].data() } as FamilyProfile) : null
        } catch { /* non-fatal */ }
      }

      const systemPrompt = buildSystemPrompt(members, today, !!googleTokens, userEmail, timezone, memories, profile)

      const conversationMessages: Anthropic.MessageParam[] = (messages ?? []).map(
        (m: { role: 'user' | 'assistant'; content: string }) => ({
          role: m.role,
          content: m.content,
        }),
      )

      const activeTools = googleTokens
        ? TOOLS
        : TOOLS.filter((t) => t.name !== 'get_google_events' && t.name !== 'create_google_event')

      // ── Prompt caching ──────────────────────────────────────────────────
      // The tool definitions (~23 schemas) never change, and the system prompt
      // is stable for the whole conversation (same family, same day). Without
      // caching, both are re-sent at full price on every message AND on every
      // tool-loop iteration below (up to 5×). With cache breakpoints, the API
      // re-reads them at 10% of input cost after the first call.
      //   - breakpoint on the last tool → caches all tools (hits across days /
      //     sessions / users, since tools are 100% static)
      //   - breakpoint on system → caches tools+system (hits within a day/session)
      // 1-hour TTL so the cached prefix survives a whole Copilot conversation
      // and tool-loop iterations (the default 5-min TTL can lapse between turns).
      const cachedTools = activeTools.map((t, i) =>
        i === activeTools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }
          : t,
      )
      const cachedSystem: Anthropic.TextBlockParam[] = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]

      const actions: string[] = []
      const toolCtx: ToolContext = { db, familyId, userEmail, googleTokens, actions, timezone, members }
      const pendingActions: PendingAction[] = []
      let availableCalendars: Array<{ id: string; name: string; primary: boolean }> = []
      let reply = ''
      // Accumulate token counts across all loop iterations for a single summary line.
      const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      let iterations = 0

      // Tool-use loop — up to 5 iterations.
      // anthropic.messages.stream() is used for every call so text tokens are
      // emitted to the SSE stream as they arrive. During tool-calling iterations
      // Claude rarely produces text, so no tokens flow; they all flow during the
      // final reply turn.
      for (let i = 0; i < 5; i++) {
        const streamObj = anthropic.messages.stream({
          model: AI_MODEL,
          max_tokens: 1024,
          system: cachedSystem,
          tools: cachedTools,
          messages: conversationMessages,
        })

        // Forward text deltas immediately as they arrive.
        streamObj.on('text', (token) => send({ type: 'token', token }))

        const response = await streamObj.finalMessage()
        logUsage(`agent#${i}`, AI_MODEL, response.usage)
        iterations++
        const ru = response.usage as unknown as Record<string, number>
        totalUsage.input_tokens += ru.input_tokens ?? 0
        totalUsage.output_tokens += ru.output_tokens ?? 0
        totalUsage.cache_creation_input_tokens += ru.cache_creation_input_tokens ?? 0
        totalUsage.cache_read_input_tokens += ru.cache_read_input_tokens ?? 0

        if (response.stop_reason === 'end_turn') {
          const textBlock = response.content.find((b) => b.type === 'text')
          reply = textBlock?.type === 'text' ? textBlock.text : ''
          break
        }

        if (response.stop_reason === 'tool_use') {
          conversationMessages.push({ role: 'assistant', content: response.content })

          const toolResults: Anthropic.ToolResultBlockParam[] = []

          for (const block of response.content) {
            if (block.type !== 'tool_use') continue

            if (WRITE_TOOLS.has(block.name)) {
              const input = block.input as Record<string, unknown>
              const tempId = generateId()
              pendingActions.push({ id: generateId(), tool: block.name, input, tempId })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({
                  queued: true,
                  id: tempId,
                  note: 'This action is queued for the user to confirm. Do not retry it. Summarize what you will do and ask the user to confirm.',
                }),
              })
              continue
            }

            let result: unknown
            try {
              result = await executeTool(block.name, block.input as Record<string, unknown>, toolCtx)
              // Capture calendars so the client can show a picker in the confirmation card
              if (block.name === 'list_google_calendars' && Array.isArray((result as {calendars?: unknown[]}).calendars)) {
                availableCalendars = (result as {calendars: Array<{id: string; name: string; primary: boolean}>}).calendars
              }
            } catch (e: unknown) {
              result = { error: e instanceof Error ? e.message : String(e) }
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })
          }

          conversationMessages.push({ role: 'user', content: toolResults })

          if (i === 4) {
            // Safety: final iteration — squeeze out a text reply with reduced tokens.
            const finalStream = anthropic.messages.stream({
              model: AI_MODEL,
              max_tokens: 512,
              system: cachedSystem,
              tools: cachedTools,
              messages: conversationMessages,
            })
            finalStream.on('text', (token) => send({ type: 'token', token }))
            const finalResponse = await finalStream.finalMessage()
            logUsage('agent#final', AI_MODEL, finalResponse.usage)
            iterations++
            const fru = finalResponse.usage as unknown as Record<string, number>
            totalUsage.input_tokens += fru.input_tokens ?? 0
            totalUsage.output_tokens += fru.output_tokens ?? 0
            totalUsage.cache_creation_input_tokens += fru.cache_creation_input_tokens ?? 0
            totalUsage.cache_read_input_tokens += fru.cache_read_input_tokens ?? 0
            const textBlock = finalResponse.content.find((b) => b.type === 'text')
            reply = textBlock?.type === 'text' ? textBlock.text : 'Done.'
          }
          continue
        }

        // Unexpected stop reason
        const textBlock = response.content.find((b) => b.type === 'text')
        reply = textBlock?.type === 'text' ? textBlock.text : ''
        break
      }

      console.log(
        `[agent] turns=${iterations} model=${AI_MODEL}` +
        ` in=${totalUsage.input_tokens} cw=${totalUsage.cache_creation_input_tokens}` +
        ` cr=${totalUsage.cache_read_input_tokens} out=${totalUsage.output_tokens}` +
        ` cost=${estimateCost(AI_MODEL, totalUsage)}`
      )
      send({ type: 'done', reply, pendingActions, actions, availableCalendars })
    } catch (e: unknown) {
      console.error('[agent] error:', e)
      send({ type: 'error', error: e instanceof Error ? e.message : 'Internal error' })
    } finally {
      closeStream()
    }
  })()

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
