import { NextRequest, NextResponse } from 'next/server'
import { updateEvent, deleteEvent } from '@/lib/google/calendar'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const { accessToken, refreshToken, calendarId, updates } = await request.json()
  if (!accessToken || !refreshToken) return NextResponse.json({ error: 'Tokens required' }, { status: 401 })
  try {
    const updated = await updateEvent(accessToken, refreshToken, params.id, calendarId, updates)
    return NextResponse.json({ event: updated })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Calendar error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { accessToken, refreshToken, calendarId } = await request.json()
  if (!accessToken || !refreshToken) return NextResponse.json({ error: 'Tokens required' }, { status: 401 })
  try {
    await deleteEvent(accessToken, refreshToken, params.id, calendarId)
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Calendar error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
