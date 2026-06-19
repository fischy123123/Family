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
  recurringEventId?: string  // set if this is an instance of a recurring event
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

        const eventEntry: GoogleEvent = {
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
          ownerEmail: cal.id?.includes('@') ? cal.id : '',
        }
        if (item.recurringEventId) eventEntry.recurringEventId = item.recurringEventId
        allEvents.push(eventEntry)
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

// Thrown when a syncToken is no longer valid (Google returns 410 Gone).
// The caller should discard stored tokens and fall back to a full sync.
export class SyncTokenExpiredError extends Error {
  constructor() { super('syncToken expired') }
}

export interface EventsDelta {
  upserted: GoogleEvent[]   // new or modified events
  deletedIds: string[]      // event ids that were deleted in Google Calendar
  syncTokensByCalendar: Record<string, string>  // updated tokens to store
}

// Incremental sync using per-calendar syncTokens.
// On first call (no stored tokens) it falls back to a 14-day full fetch and
// returns the tokens to store for next time.
// When a token is expired (410), throws SyncTokenExpiredError so the caller
// can wipe stored tokens and retry with a full fetch.
export async function getEventsDelta(
  accessToken: string,
  refreshToken: string,
  storedTokens: Record<string, string>,  // { calendarId: syncToken }
  timeMin: string,
  timeMax: string,
): Promise<EventsDelta> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })

  const { data: calListData } = await calendar.calendarList.list()
  const calendars = calListData.items ?? []

  const upserted: GoogleEvent[] = []
  const deletedIds: string[] = []
  const newTokens: Record<string, string> = {}

  for (const cal of calendars) {
    if (!cal.id) continue
    const storedToken = storedTokens[cal.id]

    try {
      // With a syncToken we get only changes; without we do a full time-windowed fetch
      const params = storedToken
        ? { calendarId: cal.id, syncToken: storedToken, showDeleted: true, singleEvents: true }
        : { calendarId: cal.id, timeMin, timeMax, singleEvents: true, orderBy: 'startTime' as const, showDeleted: false }

      const { data: eventsData } = await calendar.events.list(params)
      if (eventsData.nextSyncToken) newTokens[cal.id] = eventsData.nextSyncToken

      for (const item of eventsData.items ?? []) {
        if (!item.id) continue
        if (item.status === 'cancelled') {
          deletedIds.push(item.id)
          continue
        }
        const isAllDay = !item.start?.dateTime
        const colorId = item.colorId ?? cal.colorId ?? ''
        const event: GoogleEvent = {
          id: item.id,
          title: item.summary ?? '',
          start: item.start?.dateTime ?? item.start?.date ?? '',
          end: item.end?.dateTime ?? item.end?.date ?? '',
          isAllDay,
          location: item.location ?? '',
          notes: item.description ?? '',
          color: COLOR_MAP[colorId] ?? DEFAULT_COLOR,
          calendarId: cal.id,
          calendarName: cal.summary ?? '',
          ownerEmail: cal.id?.includes('@') ? cal.id : '',
        }
        if (item.recurringEventId) event.recurringEventId = item.recurringEventId
        upserted.push(event)
      }
    } catch (err: unknown) {
      const status = (err as { code?: number; status?: number }).code
        ?? (err as { code?: number; status?: number }).status
      if (status === 410) throw new SyncTokenExpiredError()
      console.warn(`Skipping calendar ${cal.id}:`, err)
    }
  }

  return { upserted, deletedIds, syncTokensByCalendar: newTokens }
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
    timezone?: string
  }
): Promise<GoogleEvent> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })
  const calendarId = event.calendarId ?? 'primary'
  // Only pass timeZone when we actually know it. Passing 'UTC' as a default
  // causes "2:00 PM" (local intent) to be stored as 2 PM UTC = 7 AM Pacific.
  // Without a timeZone, Google Calendar interprets the datetime in the user's
  // calendar's own default timezone — a much safer fallback.
  const tz = event.timezone

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
      : { dateTime: event.start, ...(tz ? { timeZone: tz } : {}) },
    end: event.isAllDay
      ? { date: event.end.split('T')[0] }
      : { dateTime: event.end, ...(tz ? { timeZone: tz } : {}) },
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
    timezone?: string
  }
): Promise<GoogleEvent> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const calendar = google.calendar({ version: 'v3', auth })
  const tz = updates.timezone // undefined is safe — see createEvent comment above

  const requestBody: Record<string, unknown> = {}
  if (updates.title !== undefined) requestBody.summary = updates.title
  if (updates.location !== undefined) requestBody.location = updates.location
  if (updates.notes !== undefined) requestBody.description = updates.notes
  if (updates.start !== undefined) {
    requestBody.start = updates.isAllDay
      ? { date: updates.start.split('T')[0] }
      : { dateTime: updates.start, ...(tz ? { timeZone: tz } : {}) }
  }
  if (updates.end !== undefined) {
    requestBody.end = updates.isAllDay
      ? { date: updates.end.split('T')[0] }
      : { dateTime: updates.end, ...(tz ? { timeZone: tz } : {}) }
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
