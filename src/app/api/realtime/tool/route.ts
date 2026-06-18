import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { executeTool, type ToolContext } from '@/lib/agent/tools'
import type { FamilyMember } from '@/lib/types'

// ---------------------------------------------------------------------------
// Executes a single tool call made by the Realtime voice model. Unlike the
// text agent (which queues write tools for a confirmation card), the realtime
// model confirms verbally before calling write tools, so we execute directly.
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const { tool, input, familyId, userEmail, googleTokens, timezone, members } =
      (await request.json()) as {
        tool: string
        input: Record<string, unknown>
        familyId: string
        userEmail?: string
        googleTokens?: { accessToken: string; refreshToken: string } | null
        timezone?: string
        members?: FamilyMember[]
      }

    if (!familyId || !tool) {
      return NextResponse.json({ error: 'familyId and tool are required' }, { status: 400 })
    }

    let db: FirebaseFirestore.Firestore | null = null
    try {
      const adminApp = getAdminApp()
      if (adminApp) db = getFirestore(adminApp)
    } catch {
      /* db stays null */
    }

    const actions: string[] = []
    const ctx: ToolContext = {
      db,
      familyId,
      userEmail: userEmail ?? '',
      googleTokens: googleTokens ?? null,
      actions,
      timezone,
      members: members ?? [],
    }

    const result = await executeTool(tool, input ?? {}, ctx)
    return NextResponse.json({ result, actions })
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Tool execution failed' },
      { status: 500 },
    )
  }
}
