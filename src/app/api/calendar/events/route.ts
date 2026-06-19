import { NextRequest, NextResponse } from 'next/server'
import { getEvents, createEvent } from '@/lib/google/calendar'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const accessToken = searchParams.get('accessToken')
  const refreshToken = searchParams.get('refreshToken')
  const timeMin = searchParams.get('timeMin') ?? new Date().toISOString()
  const timeMax = searchParams.get('timeMax') ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  if (!accessToken || !refreshToken) return NextResponse.json({ error: 'Tokens required' }, { status: 401 })

  try {
    const t0 = Date.now()
    const events = await getEvents(accessToken, refreshToken, timeMin, timeMax)
    console.log(`[perf/calendar-fetch] duration=${Date.now() - t0}ms events=${events.length}`)
    return NextResponse.json({ events })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Calendar error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { accessToken, refreshToken, event } = await request.json()
  if (!accessToken || !refreshToken) return NextResponse.json({ error: 'Tokens required' }, { status: 401 })
  try {
    const created = await createEvent(accessToken, refreshToken, event)
    return NextResponse.json({ event: created })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Calendar error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
