import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { updateEvent, deleteEvent } from '@/lib/google/calendar'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { calendarId, ...updates } = body
  await updateEvent(session.accessToken, calendarId ?? 'primary', params.id, updates)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const calendarId = searchParams.get('calendarId') ?? 'primary'
  await deleteEvent(session.accessToken, calendarId, params.id)
  return NextResponse.json({ ok: true })
}
