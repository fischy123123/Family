import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import {
  WRITE_TOOLS,
  executeTool,
  type ToolContext,
  type PendingAction,
} from '@/lib/agent/tools'
import type { FamilyMember } from '@/lib/types'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// API route — EXECUTE phase
//
// Runs the write actions the user has approved. Actions are processed in order
// so that create_* actions can be referenced by follow-up actions (e.g.
// add_shopping_items referencing a just-created list). Temp ids assigned during
// the propose phase are mapped to real ids here.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const { actions, familyId, userEmail, googleTokens, timezone } = (await request.json()) as {
      actions: PendingAction[]
      familyId: string
      userEmail: string
      googleTokens: { accessToken: string; refreshToken: string } | null
      timezone?: string
    }

    if (!familyId) {
      return NextResponse.json({ error: 'familyId is required' }, { status: 400 })
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      return NextResponse.json({ ok: true, results: [], actions: [] })
    }

    let db: FirebaseFirestore.Firestore | null = null
    try {
      const adminApp = getAdminApp()
      if (adminApp) db = getFirestore(adminApp)
    } catch {
      // db stays null; tools handle this gracefully
    }

    // Load members so assignee names in queued actions resolve to ids
    // (works for emailless children/pets).
    let members: FamilyMember[] = []
    if (db) {
      try {
        const snap = await db.collection('families').doc(familyId).collection('members').get()
        members = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FamilyMember)
      } catch {
        // non-fatal — assignment falls back to whatever email the AI provided
      }
    }

    const performed: string[] = []
    const ctx: ToolContext = { db, familyId, userEmail, googleTokens: googleTokens ?? null, actions: performed, members, timezone }

    // Map temp ids (from propose phase) → real ids created during execution
    const idMap: Record<string, string> = {}

    const results: Array<{ id: string; tool: string; ok: boolean; error?: string }> = []

    for (const action of actions) {
      // Only allow write tools through this endpoint
      if (!WRITE_TOOLS.has(action.tool)) {
        results.push({ id: action.id, tool: action.tool, ok: false, error: 'Not an executable action' })
        continue
      }

      const input = { ...action.input }
      // Resolve any temp id references to real ids
      if (typeof input.list_id === 'string' && idMap[input.list_id]) {
        input.list_id = idMap[input.list_id]
      }
      if (typeof input.checklist_id === 'string' && idMap[input.checklist_id]) {
        input.checklist_id = idMap[input.checklist_id]
      }

      try {
        const result = await executeTool(action.tool, input, ctx)
        if (action.tempId && result?.id) {
          idMap[action.tempId] = result.id as string
        }
        const ok = !('error' in result)
        results.push({
          id: action.id,
          tool: action.tool,
          ok,
          error: ok ? undefined : String((result as { error?: string }).error),
        })
      } catch (e: unknown) {
        results.push({
          id: action.id,
          tool: action.tool,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return NextResponse.json({ ok: true, results, actions: performed })
  } catch (e: unknown) {
    console.error('[agent/execute] error:', e)
    const msg = e instanceof Error ? e.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
