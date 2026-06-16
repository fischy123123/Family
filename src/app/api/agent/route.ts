import { NextRequest, NextResponse } from 'next/server'
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
// API route — PROPOSE phase
//
// Read tools run live so the AI can gather context. Write tools are NOT
// executed; instead each one is captured as a "pending action" and a synthetic
// "queued" tool result is fed back so the AI can finish its turn and summarize
// what it intends to do. The client then shows a confirmation card, and on
// approval calls /api/agent/execute to actually apply the actions.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const { messages, familyId, userEmail, googleTokens, context } = await request.json()

    if (!familyId) {
      return NextResponse.json({ error: 'familyId is required' }, { status: 400 })
    }

    // Firestore (may be null if service account not configured — read tools degrade gracefully)
    let db: FirebaseFirestore.Firestore | null = null
    try {
      const adminApp = getAdminApp()
      if (adminApp) {
        db = getFirestore(adminApp)
      }
    } catch {
      // db stays null; tools handle this gracefully
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
    }
    const anthropic = new Anthropic({ apiKey })

    const members: FamilyMember[] = context?.members ?? []
    const today: string = context?.today ?? new Date().toISOString()
    const timezone: string | undefined = context?.timezone

    // Load the family's durable memory + profile (the lens) so Copilot reasons
    // with the same brain the home briefing uses. Degrades silently without admin.
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
      } catch {
        // non-fatal — Copilot still works without the brain context
      }
    }

    const systemPrompt = buildSystemPrompt(members, today, !!googleTokens, userEmail, timezone, memories, profile)

    const conversationMessages: Anthropic.MessageParam[] = (messages ?? []).map(
      (m: { role: 'user' | 'assistant'; content: string }) => ({
        role: m.role,
        content: m.content,
      }),
    )

    // Only include Google tools if tokens are present
    const activeTools = googleTokens
      ? TOOLS
      : TOOLS.filter((t) => t.name !== 'get_google_events' && t.name !== 'create_google_event')

    const actions: string[] = []
    const toolCtx: ToolContext = { db, familyId, userEmail, googleTokens, actions, timezone }

    // Write tools requested by the AI this turn — these get queued, not run.
    const pendingActions: PendingAction[] = []

    let reply = ''

    // Tool-use loop (max 5 iterations to prevent infinite loops)
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: activeTools,
        messages: conversationMessages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text')
        reply = textBlock?.type === 'text' ? textBlock.text : ''
        break
      }

      if (response.stop_reason === 'tool_use') {
        // Add assistant message (with tool_use blocks) to history
        conversationMessages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          // WRITE tool → queue for confirmation instead of executing
          if (WRITE_TOOLS.has(block.name)) {
            const input = block.input as Record<string, unknown>
            // Give create_* a temp id so a follow-up action can reference it
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

          // READ tool → execute live
          let result: unknown
          try {
            result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              toolCtx,
            )
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

        // If this is the last iteration, squeeze out a text reply
        if (i === 4) {
          const finalResponse = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 512,
            system: systemPrompt,
            tools: activeTools,
            messages: conversationMessages,
          })
          const textBlock = finalResponse.content.find((b) => b.type === 'text')
          reply = textBlock?.type === 'text' ? textBlock.text : 'Done.'
        }
        continue
      }

      // Unexpected stop reason (e.g. max_tokens mid-turn)
      const textBlock = response.content.find((b) => b.type === 'text')
      reply = textBlock?.type === 'text' ? textBlock.text : ''
      break
    }

    return NextResponse.json({ reply, pendingActions, actions })
  } catch (e: unknown) {
    console.error('[agent] error:', e)
    const msg = e instanceof Error ? e.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
