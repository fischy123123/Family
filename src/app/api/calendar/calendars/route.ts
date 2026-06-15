import { NextRequest, NextResponse } from 'next/server'
import { getCalendars } from '@/lib/google/calendar'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const accessToken = searchParams.get('accessToken')
  const refreshToken = searchParams.get('refreshToken')

  if (!accessToken || !refreshToken) {
    return NextResponse.json({ error: 'Tokens required' }, { status: 401 })
  }

  try {
    const calendars = await getCalendars(accessToken, refreshToken)
    const writable = calendars
      .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
      .map((c) => ({
        id: c.id,
        name: c.summary,
        primary: c.primary ?? false,
        backgroundColor: c.backgroundColor,
      }))
    return NextResponse.json({ calendars: writable })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Calendar list error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
