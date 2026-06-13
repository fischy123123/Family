import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { upsertRow } from '@/lib/google/sheets'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken || !session.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { subscription } = await req.json()
  await upsertRow(session.accessToken, 'push_subscriptions', session.user.email, [
    session.user.email,
    JSON.stringify(subscription),
  ])

  return NextResponse.json({ ok: true })
}
