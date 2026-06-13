import { google } from 'googleapis'
import { createOAuth2Client } from './client'
import type { CalendarEvent } from '../types'

function getCalendar(accessToken: string) {
  return google.calendar({ version: 'v3', auth: createOAuth2Client(accessToken) })
}

export async function getEvents(
  accessToken: string,
  memberColorMap: Record<string, string>,
  timeMin?: string,
  timeMax?: string
): Promise<CalendarEvent[]> {
  const calendar = getCalendar(accessToken)

  const calListRes = await calendar.calendarList.list()
  const calendars = calListRes.data.items ?? []

  const now = new Date()
  const min = timeMin ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const max =
    timeMax ?? new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString()

  const allEvents: CalendarEvent[] = []

  for (const cal of calendars) {
    if (!cal.id || cal.accessRole === 'freeBusyReader') continue

    const res = await calendar.events.list({
      calendarId: cal.id,
      timeMin: min,
      timeMax: max,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    })

    const items = res.data.items ?? []
    for (const item of items) {
      if (!item.id || !item.summary) continue
      const ownerEmail = cal.id === 'primary' ? '' : cal.id
      const color =
        memberColorMap[ownerEmail] ??
        memberColorMap[cal.summary ?? ''] ??
        '#3B82F6'

      const isAllDay = !!item.start?.date && !item.start?.dateTime
      const start = item.start?.dateTime ?? item.start?.date ?? ''
      const end = item.end?.dateTime ?? item.end?.date ?? start

      allEvents.push({
        id: item.id,
        title: item.summary,
        start,
        end,
        isAllDay,
        location: item.location ?? '',
        notes: item.description ?? '',
        calendarId: cal.id,
        ownerEmail,
        color,
      })
    }
  }

  return allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}

export async function createEvent(
  accessToken: string,
  event: Omit<CalendarEvent, 'id' | 'ownerEmail' | 'color'> & { calendarId?: string }
): Promise<CalendarEvent> {
  const calendar = getCalendar(accessToken)

  const body: Record<string, unknown> = {
    summary: event.title,
    location: event.location,
    description: event.notes,
  }

  if (event.isAllDay) {
    body.start = { date: event.start.split('T')[0] }
    body.end = { date: event.end.split('T')[0] }
  } else {
    body.start = { dateTime: event.start }
    body.end = { dateTime: event.end }
  }

  const res = await calendar.events.insert({
    calendarId: event.calendarId ?? 'primary',
    requestBody: body,
  })

  return {
    id: res.data.id!,
    title: res.data.summary!,
    start: (res.data.start?.dateTime ?? res.data.start?.date)!,
    end: (res.data.end?.dateTime ?? res.data.end?.date)!,
    isAllDay: event.isAllDay,
    location: res.data.location ?? '',
    notes: res.data.description ?? '',
    calendarId: event.calendarId ?? 'primary',
    ownerEmail: '',
    color: '#3B82F6',
  }
}

export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  updates: Partial<Omit<CalendarEvent, 'id' | 'calendarId' | 'ownerEmail' | 'color'>>
): Promise<void> {
  const calendar = getCalendar(accessToken)

  const body: Record<string, unknown> = {}
  if (updates.title) body.summary = updates.title
  if (updates.location !== undefined) body.location = updates.location
  if (updates.notes !== undefined) body.description = updates.notes

  if (updates.isAllDay !== undefined && updates.start && updates.end) {
    if (updates.isAllDay) {
      body.start = { date: updates.start.split('T')[0] }
      body.end = { date: updates.end.split('T')[0] }
    } else {
      body.start = { dateTime: updates.start }
      body.end = { dateTime: updates.end }
    }
  }

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: body,
  })
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const calendar = getCalendar(accessToken)
  await calendar.events.delete({ calendarId, eventId })
}
