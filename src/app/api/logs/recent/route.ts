import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import type { AttentionDiagRun } from '@/lib/diagnostics'

// Returns recent attention-engine diagnostic runs from Firestore.
// Protected by CRON_SECRET so it's accessible to Claude Code without
// requiring user auth, while still being locked down from public access.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  const secret = process.env.CRON_SECRET
  if (!secret || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getAdminDb()
    const snap = await db.doc('_diagnostics/attention').get()
    const runs: AttentionDiagRun[] = snap.exists ? (snap.data()?.runs ?? []) : []
    // Return newest first, limit to last 20
    const recent = [...runs].reverse().slice(0, 20)
    return NextResponse.json({ runs: recent, count: recent.length })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to read diagnostics' },
      { status: 500 },
    )
  }
}
