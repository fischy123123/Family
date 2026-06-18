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

      const actions: string[] = []
      const toolCtx: ToolContext = { db, familyId, userEmail, googleTokens, actions, timezone, members }
      const pendingActions: PendingAction[] = []
      let reply = ''

      // Tool-use loop — up to 5 iterations.
      // anthropic.messages.stream() is used for every call so text tokens are
      // emitted to the SSE stream as they arrive. During tool-calling iterations
      // Claude rarely produces text, so no tokens flow; they all flow during the
      // final reply turn.
      for (let i = 0; i < 5; i++) {
        const streamObj = anthropic.messages.stream({
          model: AI_MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          tools: activeTools,
          messages: conversationMessages,
        })

        // Forward text deltas immediately as they arrive.
        streamObj.on('text', (token) => send({ type: 'token', token }))

        const response = await streamObj.finalMessage()

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
              system: systemPrompt,
              tools: activeTools,
              messages: conversationMessages,
            })
            finalStream.on('text', (token) => send({ type: 'token', token }))
            const finalResponse = await finalStream.finalMessage()
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

      send({ type: 'done', reply, pendingActions, actions })
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
