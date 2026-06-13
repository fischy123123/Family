import { google } from 'googleapis'
import { getAuthorizedClient } from './oauth'

const COLOR_MAP: Record<string, string> = {
  '1': '#AC725E',
  '2': '#D06B64',
  '3': '#F83A22',
  '4': '#FA573C',
  '5': '#FF7537',
  '6': '#FFAD46',
  '7': '#42D692',
  '8': '#16A765',
  '9': '#7BD148',
  '10': '#B3DC6C',
  '11': '#FBE983',
}

const DEFAULT_COLOR = '#3B82F6'

export interface GoogleEvent {
  id: string
  title: string
  start: string
  end: string
  isAllDay: boolean
  location: string
  notes: string
  color: string
  calendarId: string
  calendarName: string
  ownerEmail: string
}

export async function getCalendars(accessToken: string, refreshToken: string) {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })
  const { data } = await calendar.calendarList.list()
  return data.items ?? []
}

export async function getEvents(
  accessToken: string,
  refreshToken: string,
  timeMin: string,
  timeMax: string
): Promise<GoogleEvent[]> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })

  const { data: calListData } = await calendar.calendarList.list()
  const calendars = calListData.items ?? []

  const allEvents: GoogleEvent[] = []

  for (const cal of calendars) {
    if (!cal.id) continue
    try {
      const { data: eventsData } = await calendar.events.list({
        calendarId: cal.id,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      })

      const items = eventsData.items ?? []
      for (const item of items) {
        if (!item.id) continue
        const isAllDay = !item.start?.dateTime
        const start = item.start?.dateTime ?? item.start?.date ?? ''
        const end = item.end?.dateTime ?? item.end?.date ?? ''
        const colorId = item.colorId ?? cal.colorId ?? ''
        const color = COLOR_MAP[colorId] ?? DEFAULT_COLOR

        allEvents.push({
          id: item.id,
          title: item.summary ?? '',
          start,
          end,
          isAllDay,
          location: item.location ?? '',
          notes: item.description ?? '',
          color,
          calendarId: cal.id,
          calendarName: cal.summary ?? '',
          ownerEmail: '',
        })
      }
    } catch (err) {
      // Some calendars may be inaccessible; skip them
      console.warn(`Skipping calendar ${cal.id}:`, err)
    }
  }

  // Sort by start time
  allEvents.sort((a, b) => {
    const aTime = new Date(a.start).getTime()
    const bTime = new Date(b.start).getTime()
    return aTime - bTime
  })

  return allEvents
}

export async function createEvent(
  accessToken: string,
  refreshToken: string,
  event: {
    title: string
    start: string
    end: string
    isAllDay: boolean
    location?: string
    notes?: string
    calendarId?: string
  }
): Promise<GoogleEvent> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })
  const calendarId = event.calendarId ?? 'primary'

  const requestBody: {
    summary: string
    location?: string
    description?: string
    start: { date?: string; dateTime?: string; timeZone?: string }
    end: { date?: string; dateTime?: string; timeZone?: string }
  } = {
    summary: event.title,
    location: event.location,
    description: event.notes,
    start: event.isAllDay
      ? { date: event.start.split('T')[0] }
      : { dateTime: event.start, timeZone: 'UTC' },
    end: event.isAllDay
      ? { date: event.end.split('T')[0] }
      : { dateTime: event.end, timeZone: 'UTC' },
  }

  const { data } = await calendar.events.insert({ calendarId, requestBody })

  return {
    id: data.id ?? '',
    title: data.summary ?? '',
    start: data.start?.dateTime ?? data.start?.date ?? '',
    end: data.end?.dateTime ?? data.end?.date ?? '',
    isAllDay: !data.start?.dateTime,
    location: data.location ?? '',
    notes: data.description ?? '',
    color: COLOR_MAP[data.colorId ?? ''] ?? DEFAULT_COLOR,
    calendarId,
    calendarName: '',
    ownerEmail: '',
  }
}

export async function updateEvent(
  accessToken: string,
  refreshToken: string,
  eventId: string,
  calendarId: string,
  updates: {
    title?: string
    start?: string
    end?: string
    isAllDay?: boolean
    location?: string
    notes?: string
  }
): Promise<GoogleEvent> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })

  const requestBody: Record<string, unknown> = {}
  if (updates.title !== undefined) requestBody.summary = updates.title
  if (updates.location !== undefined) requestBody.location = updates.location
  if (updates.notes !== undefined) requestBody.description = updates.notes
  if (updates.start !== undefined) {
    requestBody.start = updates.isAllDay
      ? { date: updates.start.split('T')[0] }
      : { dateTime: updates.start, timeZone: 'UTC' }
  }
  if (updates.end !== undefined) {
    requestBody.end = updates.isAllDay
      ? { date: updates.end.split('T')[0] }
      : { dateTime: updates.end, timeZone: 'UTC' }
  }

  const { data } = await calendar.events.patch({ calendarId, eventId, requestBody })

  return {
    id: data.id ?? '',
    title: data.summary ?? '',
    start: data.start?.dateTime ?? data.start?.date ?? '',
    end: data.end?.dateTime ?? data.end?.date ?? '',
    isAllDay: !data.start?.dateTime,
    location: data.location ?? '',
    notes: data.description ?? '',
    color: COLOR_MAP[data.colorId ?? ''] ?? DEFAULT_COLOR,
    calendarId,
    calendarName: '',
    ownerEmail: '',
  }
}

export async function deleteEvent(
  accessToken: string,
  refreshToken: string,
  eventId: string,
  calendarId: string
): Promise<void> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.events.delete({ calendarId, eventId })
}
