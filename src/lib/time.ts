// ── Single source of truth for timezone handling ────────────────────────────
// Server code runs in UTC on Vercel. Any `toLocaleString`/`toLocaleDateString`
// call that omits `timeZone` (or passes `undefined`) silently formats in UTC,
// which shifts every time by the user's UTC offset — e.g. an 11:00 AM Pacific
// event reads as "6:00 PM" to the AI. That single class of bug is responsible
// for calendar-vs-AI time mismatches across the app.
//
// Rule: NEVER format a user-facing or AI-facing time without an explicit IANA
// timezone. When a caller genuinely can't supply the user's zone, fall back to
// the family's home timezone (below) rather than UTC.

// The family's home timezone. Used as the fallback whenever an explicit IANA
// zone isn't available. Pacific is correct for this household and matches the
// fallback already hardcoded in the coach cron and attention-patch routes.
export const DEFAULT_TIMEZONE = 'America/Los_Angeles'

// Coerce a possibly-missing/blank timezone into a usable IANA zone. This is the
// guard that prevents a silent UTC fallback anywhere in the codebase.
export function resolveTimezone(tz?: string | null): string {
  return tz && tz.trim() ? tz : DEFAULT_TIMEZONE
}

// Date-only strings ("YYYY-MM-DD") carry no time or zone. Parsing one with
// `new Date()` yields UTC midnight, which any timezone behind UTC (e.g. Pacific)
// then renders as the PREVIOUS calendar day — the classic off-by-one. Detect
// these and render the literal calendar parts with NO timezone conversion.
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// Format a date-only or full ISO value as a plain calendar date (no time).
// Date-only values are pinned to UTC so the calendar parts render exactly as
// written regardless of the runtime/target zone; timed values are converted to
// the user's local zone.
export function formatDate(iso: string, tz?: string): string {
  const trimmed = iso.trim()
  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }
  try {
    return new Date(trimmed).toLocaleDateString('en-US', {
      timeZone: resolveTimezone(tz),
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return new Date(iso).toDateString()
  }
}

// Format a date/time in the user's local timezone. All-day / date-only values
// have no time component, so they render as a plain date (never inventing a
// spurious time or shifting the day).
export function formatDateTime(iso: string, tz?: string): string {
  if (DATE_ONLY_RE.test(iso.trim())) return formatDate(iso, tz)
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: resolveTimezone(tz),
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })
  } catch {
    return new Date(iso).toISOString()
  }
}

// Format just the time portion (e.g. "11:00 AM") in the user's local zone.
export function formatTimeOnly(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: resolveTimezone(tz),
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
