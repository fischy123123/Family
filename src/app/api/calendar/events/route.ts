import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getEvents, createEvent } from '@/lib/google/calendar'
import { readSheet } from '@/lib/google/sheets'
import type { FamilyMember } from '@/lib/types'

async function getMemberColorMap(accessToken: string): Promise<Record<string, string>> {
  const rows = await readSheet(accessToken, 'family')
  const map: Record<string, string> = {}
  for (const row of rows.slice(1)) {
    if (row[2] && row[3]) map[row[2]] = row[3] // email -> colorHex
  }
  return map
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const timeMin = searchParams.get('timeMin') ?? undefined
  const timeMax = searchParams.get('timeMax') ?? undefined

  const colorMap = await getMemberColorMap(session.accessToken)
  const events = await getEvents(session.accessToken, colorMap, timeMin, timeMax)
  return NextResponse.json(events)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const event = await createEvent(session.accessToken, body)
  return NextResponse.json(event)
}
