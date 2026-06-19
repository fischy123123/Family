import Anthropic from '@anthropic-ai/sdk'
import { generateId } from '@/lib/utils'
import { getEvents, getCalendars, createEvent as createGoogleEvent, updateEvent, deleteEvent } from '@/lib/google/calendar'
import { resolveMemberRef } from '@/lib/members'
import type { FamilyMember, FamilyMemory, FamilyProfile } from '@/lib/types'

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Anthropic.Tool[] = [
  // --- Read tools ---
  {
    name: 'list_events',
    description: 'Get upcoming calendar events from the family Firestore calendar',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days ahead to look (default 14)',
        },
      },
    },
  },
  {
    name: 'list_reminders',
    description: 'Get family reminders',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_completed: {
          type: 'boolean',
          description: 'Whether to include completed reminders (default false)',
        },
      },
    },
  },
  {
    name: 'list_chores',
    description: 'Get family chores and their schedules',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_shopping_lists',
    description: 'Get all shopping lists with their items',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_checklists',
    description: 'Get all checklists with their items',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_meal_plan',
    description: 'Get the meal plan for a specific week',
    input_schema: {
      type: 'object' as const,
      properties: {
        week_offset: {
          type: 'number',
          description: '0 = this week, 1 = next week, -1 = last week (default 0)',
        },
      },
    },
  },
  {
    name: 'list_memories',
    description: "Get the durable facts the assistant knows about this family (allergies, routines, preferences, relationships, logistics). Check this when answering questions about the family or before assuming you don't know something.",
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // --- Write tools ---
  {
    name: 'create_event',
    description: 'Create a calendar event in Firestore',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_datetime: {
          type: 'string',
          description: 'Start datetime as ISO 8601 string (e.g. 2024-03-15T14:00:00) or date only for all-day (e.g. 2024-03-15)',
        },
        end_datetime: {
          type: 'string',
          description: 'End datetime as ISO 8601 string or date only',
        },
        is_all_day: { type: 'boolean', description: 'Whether the event is all-day' },
        location: { type: 'string', description: 'Optional location' },
        notes: { type: 'string', description: 'Optional notes' },
        assignee: { type: 'string', description: 'Optional NAME of the family member this is for (use their name, works for children/pets without an email)' },
      },
      required: ['title', 'start_datetime', 'end_datetime'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a family reminder',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Reminder title' },
        due_date: { type: 'string', description: 'Due date as ISO 8601 (e.g. 2024-03-15T09:00:00)' },
        priority: { type: 'string', description: 'Priority: none, low, medium, or high' },
        assignee: { type: 'string', description: 'Optional NAME of who this is assigned to (use their name, works for children/pets without an email)' },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_chore',
    description: 'Create a recurring chore',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Chore name' },
        assignee: { type: 'string', description: 'NAME of the family member assigned to this chore (use their name, works for children/pets without an email)' },
        frequency: { type: 'string', description: 'Recurrence frequency: daily, weekly, or monthly' },
        interval: { type: 'number', description: 'Interval for recurrence (e.g. 2 for every 2 weeks). Default 1.' },
      },
      required: ['name', 'assignee', 'frequency'],
    },
  },
  {
    name: 'create_shopping_list',
    description: 'Create a new shopping list',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Shopping list name' },
        store: { type: 'string', description: 'Optional store name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_shopping_items',
    description: 'Add items to an existing shopping list',
    input_schema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'ID of the shopping list to add items to' },
        items: {
          type: 'array',
          description: 'Items to add',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string' },
              category: { type: 'string', description: 'One of: Produce, Dairy, Meat & Seafood, Bakery, Frozen, Pantry, Beverages, Household, Personal Care, Other' },
            },
            required: ['name'],
          },
        },
      },
      required: ['list_id', 'items'],
    },
  },
  {
    name: 'create_checklist',
    description: 'Create a new checklist',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Checklist name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_checklist_items',
    description: 'Add items to an existing checklist',
    input_schema: {
      type: 'object' as const,
      properties: {
        checklist_id: { type: 'string', description: 'ID of the checklist' },
        items: {
          type: 'array',
          description: 'Item titles to add',
          items: { type: 'string' },
        },
      },
      required: ['checklist_id', 'items'],
    },
  },
  {
    name: 'set_meal',
    description: 'Set or update a meal plan entry for a specific date',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date as YYYY-MM-DD' },
        meal_name: { type: 'string', description: 'Name of the meal (e.g. "Chicken Tacos")' },
        ingredients: {
          type: 'array',
          description: 'List of ingredient strings',
          items: { type: 'string' },
        },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['date', 'meal_name', 'ingredients'],
    },
  },
  {
    name: 'complete_reminder',
    description: 'Mark a reminder as completed',
    input_schema: {
      type: 'object' as const,
      properties: {
        reminder_id: { type: 'string', description: 'ID of the reminder to complete' },
      },
      required: ['reminder_id'],
    },
  },
  {
    name: 'complete_chore',
    description: 'Mark a chore as completed (updates lastCompletedDate and increments streak)',
    input_schema: {
      type: 'object' as const,
      properties: {
        chore_id: { type: 'string', description: 'ID of the chore to complete' },
      },
      required: ['chore_id'],
    },
  },

  // --- Google Calendar tools (only used when tokens are available) ---
  {
    name: 'list_google_calendars',
    description: 'List all Google Calendars the user has access to. ALWAYS call this before create_google_event so you can suggest the right calendar. Prefer a shared \'Family\' or \'family\' calendar over the primary personal calendar when adding family events.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_google_events',
    description: 'Get events from Google Calendar (only available when Google Calendar is connected)',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days ahead to look (default 14)',
        },
      },
    },
  },
  {
    name: 'create_google_event',
    description: 'Create an event in Google Calendar (only available when Google Calendar is connected)',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_datetime: {
          type: 'string',
          description: 'Start datetime in LOCAL time as YYYY-MM-DDTHH:mm:ss (no Z suffix, no timezone offset — e.g. "2026-06-17T15:00:00" for 3pm local). For all-day events use YYYY-MM-DD.',
        },
        end_datetime: {
          type: 'string',
          description: 'End datetime in LOCAL time as YYYY-MM-DDTHH:mm:ss (no Z suffix). For all-day use YYYY-MM-DD.',
        },
        is_all_day: { type: 'boolean', description: 'Whether the event is all-day' },
        location: { type: 'string', description: 'Optional location' },
        notes: { type: 'string', description: 'Optional notes/description' },
        calendar_id: { type: 'string', description: 'Google Calendar ID to create the event in. Use list_google_calendars first to find the right ID when the user specifies a named calendar. Defaults to the primary calendar if omitted.' },
      },
      required: ['title', 'start_datetime', 'end_datetime'],
    },
  },
  {
    name: 'delete_google_event',
    description: 'Delete an event from Google Calendar. Call get_google_events first to find the event_id and calendar_id of the event to delete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'Google Calendar event ID (from get_google_events)' },
        calendar_id: { type: 'string', description: 'Google Calendar ID the event belongs to (from get_google_events). Defaults to primary.' },
        event_title: { type: 'string', description: 'Human-readable event title — shown to the user in the confirmation card' },
        event_date: { type: 'string', description: 'Date/time of the event — shown to the user in the confirmation card (ISO string)' },
      },
      required: ['event_id', 'event_title'],
    },
  },
  {
    name: 'update_google_event',
    description: 'Update (edit) an existing Google Calendar event. Call get_google_events first to find the event_id and calendar_id. Only include fields that need to change. For recurring events, get_google_events returns a recurringEventId — use scope "instance" to update only this occurrence (default), or scope "all" to update the entire series (pass series_event_id = recurringEventId in that case).',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'Google Calendar event ID of the specific instance (from get_google_events)' },
        series_event_id: { type: 'string', description: 'The recurringEventId from get_google_events — only needed when scope is "all" to update the whole series' },
        calendar_id: { type: 'string', description: 'Google Calendar ID the event belongs to (from get_google_events). Defaults to primary.' },
        event_title: { type: 'string', description: 'Current title of the event — shown in the confirmation card' },
        scope: {
          type: 'string',
          enum: ['instance', 'all'],
          description: '"instance" (default) = update only this occurrence; "all" = update all occurrences in the recurring series. Only use "all" when the user explicitly asks to change every occurrence.',
        },
        title: { type: 'string', description: 'New title (omit to keep unchanged)' },
        start_datetime: { type: 'string', description: 'New start datetime in LOCAL time as YYYY-MM-DDTHH:mm:ss (omit to keep unchanged)' },
        end_datetime: { type: 'string', description: 'New end datetime in LOCAL time as YYYY-MM-DDTHH:mm:ss (omit to keep unchanged)' },
        location: { type: 'string', description: 'New location (omit to keep unchanged)' },
        notes: { type: 'string', description: 'New description/notes (omit to keep unchanged)' },
      },
      required: ['event_id', 'event_title'],
    },
  },
  {
    name: 'remember',
    description: "Store a durable fact about the family so it informs future briefings and answers. Use this whenever the user tells you something worth remembering long-term — an allergy, a routine, a preference, a relationship, a recurring logistic. Do NOT use it for one-off tasks or events (use create_reminder/create_event for those).",
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact to remember, phrased as a clear standalone statement (e.g. "Leo is allergic to peanuts")' },
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'routine', 'health', 'logistics', 'relationship', 'other'],
          description: 'Best-fit category for the fact',
        },
        subject_email: { type: 'string', description: "Email of the family member this fact is about, if it's about a specific person" },
      },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    description: "Delete a durable memory that is no longer true. Use this whenever the user corrects or updates a fact you already remember (e.g. a grounding gets extended, a routine changes, a preference flips) — forget the stale memory by its id, then call remember with the corrected fact. Each memory in your context is labelled with [id:xxx]; pass that id here. Keeping contradictory memories around makes future briefings wrong.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The id of the memory to delete (from the [id:xxx] label in your context)' },
      },
      required: ['id'],
    },
  },
]

// Tools that mutate data — these require explicit user confirmation before
// they are actually executed. Read tools run freely so the AI can gather
// context and produce an accurate preview of what it intends to do.
export const WRITE_TOOLS = new Set<string>([
  'create_event',
  'create_reminder',
  'create_chore',
  'create_shopping_list',
  'add_shopping_items',
  'create_checklist',
  'add_checklist_items',
  'set_meal',
  'complete_reminder',
  'complete_chore',
  'create_google_event',
  'delete_google_event',
  'update_google_event',
  'remember',
  'forget',
])

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  members: FamilyMember[],
  today: string,
  hasGoogleTokens: boolean,
  currentUserEmail?: string,
  timezone?: string,
  memories?: FamilyMemory[],
  profile?: FamilyProfile | null,
): string {
  const memberList = members
    .map((m) => {
      const isYou = !!currentUserEmail && m.email?.toLowerCase() === currentUserEmail.toLowerCase()
      return `  - ${m.name} (${m.email}, ${m.role})${isYou ? ' ← THIS IS THE PERSON YOU ARE TALKING TO (refer to them as "you")' : ''}`
    })
    .join('\n')

  const self = currentUserEmail
    ? members.find((m) => m.email?.toLowerCase() === currentUserEmail.toLowerCase())
    : undefined
  const signedInLine = self
    ? `You are talking to ${self.name} (${currentUserEmail}). When they say "I", "me", or "my", they mean ${self.name}.`
    : currentUserEmail
      ? `You are talking to the person signed in as ${currentUserEmail} (not yet matched to a family member profile).`
      : ''

  const calendarInstructions = hasGoogleTokens
    ? `Google Calendar is connected — prefer get_google_events and create_google_event for calendar operations. Use list_events / create_event only for Firestore-only storage. ALWAYS call list_google_calendars before create_google_event. Prefer shared family calendars over the user's primary personal calendar for family events. Pass the chosen calendar_id to create_google_event.

UPDATING EVENTS: Always use update_google_event — never delete + recreate. Call get_google_events first to find the event_id and calendar_id. Pass only the fields that change; omit unchanged fields.

RECURRING EVENTS: get_google_events returns a recurringEventId field when an event is part of a recurring series.
- Default (scope "instance"): update_google_event only changes THIS specific occurrence — use this unless the user says "change all" or "every week" etc.
- scope "all": patches the whole series — use series_event_id (the recurringEventId). Only use this when the user explicitly wants all future/past occurrences changed.
- Never assume scope "all" — always default to instance unless the user is clear about wanting all occurrences changed.

DELETING EVENTS: Call get_google_events first to get the event_id and calendar_id, then call delete_google_event. For recurring events, clarify with the user whether they want to delete just this occurrence or the whole series. Default to just this occurrence.`
    : 'Google Calendar is not connected — use list_events and create_event for Firestore-based calendar.'

  // The lens: how this family wants to be helped.
  const profileBlock = profile && (profile.household || profile.priorities?.length || profile.concerns?.length || profile.quietHours)
    ? `\nHOW THIS FAMILY WANTS TO BE HELPED (their lens — prioritize through it):\n${[
        profile.household && `- Who they are: ${profile.household}`,
        profile.priorities?.length && `- What matters most: ${profile.priorities.join('; ')}`,
        profile.concerns?.length && `- Watch out for: ${profile.concerns.join('; ')}`,
        profile.communicationStyle && `- Preferred tone: ${profile.communicationStyle}`,
        profile.quietHours && `- Quiet hours: ${profile.quietHours}`,
      ].filter(Boolean).join('\n')}\n`
    : ''

  // Durable knowledge already on file. Listed newest-first and labelled with
  // [id:xxx] so the AI can supersede a stale fact via the forget tool when the
  // user corrects it. When two entries conflict, the most recent one is current.
  const memoryBlock = memories?.length
    ? `\nWHAT YOU ALREADY KNOW ABOUT THIS FAMILY (durable memory, newest first — use it; don't ask for things you already know. If the user corrects something here, forget the old [id:xxx] and remember the new fact):\n${[...memories]
        .sort((a, b) => (!!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()))
        .slice(0, 50)
        .map((m) => `- [id:${m.id}] ${m.category ? `[${m.category}] ` : ''}${m.text}${m.subjectEmail ? ` (about ${m.subjectEmail})` : ''}`)
        .join('\n')}\n`
    : ''

  // Build an explicit day-of-week map for the next 14 days so Claude never
  // has to compute day names from dates and makes off-by-one errors.
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const WEEKDAY_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

  // Date arithmetic must account for the user's timezone, not the server's (UTC on Vercel).
  // We use Intl.DateTimeFormat so that "today" and the 14-day table reflect the user's wall clock.
  function localParts(date: Date, tz?: string): { year: number; month: number; day: number; weekday: number } {
    if (!tz) {
      return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), weekday: date.getUTCDay() }
    }
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
        .formatToParts(date)
        .map((x) => [x.type, x.value]),
    )
    return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), weekday: WEEKDAY_SHORT[p.weekday] ?? 0 }
  }

  const todayDate = new Date(today)
  const { year: tYear, month: tMonth, day: tDay, weekday: tWeekday } = localParts(todayDate, timezone)
  const todayDayName = DAY_NAMES[tWeekday]
  const todayLabel = `${todayDayName}, ${MONTH_NAMES[tMonth]} ${tDay}, ${tYear}`

  // Build a "day name → date" lookup for the next 14 days to give the AI an unambiguous reference.
  // Anchor to noon UTC on the local date to avoid DST edge cases in the addition.
  const localTodayStr = `${tYear}-${String(tMonth + 1).padStart(2, '0')}-${String(tDay).padStart(2, '0')}`
  const upcomingDays: string[] = []
  for (let i = 0; i <= 14; i++) {
    const d = new Date(`${localTodayStr}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    const { year: y, month: m, day: dy, weekday: dw } = localParts(d, timezone)
    upcomingDays.push(`${DAY_NAMES[dw]} = ${y}-${String(m + 1).padStart(2, '0')}-${String(dy).padStart(2, '0')}`)
  }
  const calendarRef = `DAY-DATE REFERENCE (authoritative — do not compute day names yourself, use this table):\n${upcomingDays.join(' | ')}`

  return `You are Copilot, the family's AI chief of staff.
Today is ${todayLabel}${timezone ? ` (user timezone: ${timezone})` : ''}.
${calendarRef}
All times you display to the user should be in ${timezone ? `the user's timezone (${timezone})` : 'local time'}, not UTC.
CRITICAL — when calling create_google_event or create_event, always use LOCAL datetime strings in the format YYYY-MM-DDTHH:mm:ss with NO "Z" suffix and NO timezone offset. "3pm" means ${timezone ?? 'local time'} 3pm, output as "YYYY-MM-DDTHH:15:00:00", not UTC.

Your job is to reduce the family's mental load. You are not a passive task bot — you are a proactive partner who keeps track of everyone's schedules, lists, and plans, and who tells the family what actually needs their attention. Think like a great executive assistant for a busy household.

${signedInLine}

Family members:
${memberList || '  (none yet)'}
${profileBlock}${memoryBlock}

NAME MATCHING (important for voice input):
Messages are often dictated, and voice transcription mis-spells family names phonetically (e.g. "Jessy" becomes "Jesse", "Aoife" becomes "Eva"). When a name in the message sounds like one of the family members above, treat it as THAT member — use their real spelling and pass their NAME in the "assignee" field when assigning tasks/events/reminders/chores. Always assign by name (not email) so it works for children and pets who have no email address. Possessives count too: "Jesse's cousin" refers to a relative of the family member Jessy. Only treat a name as someone outside the family if it clearly matches no one. If you make such a correction, reflect the corrected name naturally in your reply (e.g. "Added Jessy's haircut…") so the user can see you understood who they meant.

ALWAYS ASSIGN WHEN THERE'S A CLEAR OWNER: Whenever a task, reminder, event, or chore clearly belongs to or is about a specific family member, set "assignee" to their name. Don't leave things unassigned when the owner is obvious from the request.

${calendarInstructions}

CONFIRMATION FLOW (very important):
Any action that changes data (creating or updating events, reminders, chores, lists, checklists, meals, or marking things complete) is NOT applied immediately. When you call a write tool, it is QUEUED for the user's review — the tool result will say "queued". This is expected and correct. Do NOT retry a queued action or assume it failed. After queueing the action(s), write a short, warm confirmation message that describes what you're about to do and asks the user to confirm — e.g. "Here's what I'll do — just confirm and I'll take care of it." Do not claim the action is already done; the user still needs to approve it.

How to operate:
- Be warm, calm, and concise. Write like a trusted human assistant, not a robot. No filler, no corporate tone.
- Format your replies for easy reading. Use short paragraphs, **bold** for key names/times, and bulleted lists ("- ") when listing multiple things. Use a brief heading ("## ") only when it genuinely helps organize a longer answer. Keep it skimmable.
- Reason about timing and preparation. Think a step ahead: if an event needs prep (packing, buying something, leaving early, booking ahead), surface it. Connect the dots between calendar, lists, meals, chores, and reminders.
- Proactively flag risks or things being forgotten when it's genuinely relevant — e.g. no dinner planned, a conflict between two events, a trip with nothing packed, a deadline approaching. Don't manufacture concerns; only raise what matters.
- For write actions, queue the tool call(s) and then summarize them for confirmation as described above.
- When listing events or data, be brief — use bullet points, not paragraphs.
- When asked open-ended questions like "what needs my attention?" or "what am I forgetting?", gather the relevant context with the read tools first, then give a focused, prioritized answer.
- REMEMBER what matters. When the user shares a durable fact about the family (an allergy, a routine, a preference, a relationship, a standing logistic), quietly queue a remember action so it informs every future briefing. Don't remember one-off tasks or events. Lean on what you already know above before asking the user to repeat themselves.
- CORRECT stale memory. When the user updates or contradicts something already in durable memory (e.g. "actually Maddie's grounding is extended to Sunday" when memory says it ends Friday), queue a forget action for the old [id:xxx] AND a remember action for the corrected fact in the same turn. Never leave two contradictory memories on file — that makes briefings wrong. Match memories about a person even when tagged to that person, not just family-wide ones.

Examples of what you can do:
- "Add milk to shopping" → call list_shopping_lists to find the right list, then add_shopping_items (queued for confirmation)
- "Schedule dentist for Mia next Tuesday at 3pm" → create_event or create_google_event (queued for confirmation)
- "What do we have this week?" → get_google_events or list_events, summarize concisely
- "Add chicken tacos to Monday dinner" → set_meal (queued for confirmation)
- "Remind Eric to pay rent on the 1st" → create_reminder with assignee "Eric" (queued for confirmation)
- "What chores are due?" → list_chores

If the user asks to add something to shopping and no list exists yet, create one first with create_shopping_list, then add items with add_shopping_items — use the temporary id returned by create_shopping_list as the list_id for add_shopping_items.`
}

// ---------------------------------------------------------------------------
// Tool context + types
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: FirebaseFirestore.Firestore | null
  familyId: string
  userEmail: string
  googleTokens: { accessToken: string; refreshToken: string } | null
  actions: string[]
  timezone?: string
  members?: FamilyMember[]
}

export interface PendingAction {
  id: string
  tool: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>
  // Temporary id assigned to create_* actions during the propose phase, so
  // follow-up actions (e.g. add_shopping_items) can reference the not-yet-real id.
  tempId?: string
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<{ id?: string } & Record<string, unknown>> {
  const { db, familyId, googleTokens, actions } = ctx

  // Helper to get Firestore collection
  function col(collectionName: string) {
    if (!db) throw new Error('Firestore not available (FIREBASE_SERVICE_ACCOUNT not configured)')
    return db.collection('families').doc(familyId).collection(collectionName)
  }

  switch (name) {
    // -----------------------------------------------------------------------
    // READ TOOLS
    // -----------------------------------------------------------------------
    case 'list_events': {
      if (!db) return { error: 'Firestore admin not configured', events: [] }
      const daysAhead = (input.days_ahead as number) ?? 14
      const now = new Date()
      const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)
      const snap = await col('events').get()
      const events = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((e: Record<string, unknown>) => {
          const start = new Date(e.start as string)
          return start >= now && start <= future
        })
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          new Date(a.start as string).getTime() - new Date(b.start as string).getTime()
        )
      return { events }
    }

    case 'list_reminders': {
      if (!db) return { error: 'Firestore admin not configured', reminders: [] }
      const includeCompleted = input.include_completed as boolean ?? false
      const snap = await col('reminders').get()
      let reminders = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      if (!includeCompleted) {
        reminders = reminders.filter((r: Record<string, unknown>) => !r.isCompleted)
      }
      return { reminders }
    }

    case 'list_chores': {
      if (!db) return { error: 'Firestore admin not configured', chores: [] }
      const snap = await col('chores').get()
      const chores = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      return { chores }
    }

    case 'list_shopping_lists': {
      if (!db) return { error: 'Firestore admin not configured', lists: [] }
      const snap = await col('shopping_lists').get()
      const lists = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      return { lists }
    }

    case 'list_checklists': {
      if (!db) return { error: 'Firestore admin not configured', checklists: [] }
      const snap = await col('checklists').get()
      const checklists = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      return { checklists }
    }

    case 'list_meal_plan': {
      if (!db) return { error: 'Firestore admin not configured', meals: [] }
      const weekOffset = (input.week_offset as number) ?? 0
      const now = new Date()
      // Find Monday of the target week
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1 // 0=Mon
      const monday = new Date(now)
      monday.setDate(now.getDate() - dayOfWeek + weekOffset * 7)
      monday.setHours(0, 0, 0, 0)
      const sunday = new Date(monday)
      sunday.setDate(monday.getDate() + 6)
      sunday.setHours(23, 59, 59, 999)

      const mondayStr = monday.toISOString().split('T')[0]
      const sundayStr = sunday.toISOString().split('T')[0]

      const snap = await col('meal_plans').get()
      const meals = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((m: Record<string, unknown>) => {
          const date = m.date as string
          return date >= mondayStr && date <= sundayStr
        })
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          (a.date as string).localeCompare(b.date as string)
        )
      return { meals, weekStart: mondayStr, weekEnd: sundayStr }
    }

    case 'list_memories': {
      if (!db) return { error: 'Firestore admin not configured', memories: [] }
      const snap = await col('memories').get()
      const memories = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      return { memories }
    }

    // -----------------------------------------------------------------------
    // WRITE TOOLS
    // -----------------------------------------------------------------------
    case 'create_event': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create event.' }
      const id = generateId()
      const isAllDay = input.is_all_day as boolean ?? !input.start_datetime.includes('T')
      const assignedMember = resolveMemberRef(ctx.members ?? [], (input.assignee as string) ?? (input.assignee_email as string))
      const event = {
        title: input.title as string,
        start: input.start_datetime as string,
        end: input.end_datetime as string,
        isAllDay,
        location: (input.location as string) ?? '',
        notes: (input.notes as string) ?? '',
        calendarId: 'primary',
        ownerEmail: assignedMember?.email || (input.assignee_email as string) || ctx.userEmail,
        color: '#3B82F6',
      }
      await col('events').doc(id).set(event)
      actions.push(`Created event: ${event.title} on ${event.start.split('T')[0]}`)
      return { success: true, id, event }
    }

    case 'create_reminder': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create reminder.' }
      const id = generateId()
      const priority = (input.priority as string) ?? 'medium'
      const reminder: Record<string, unknown> = {
        title: input.title as string,
        isCompleted: false,
        priority: ['none', 'low', 'medium', 'high'].includes(priority) ? priority : 'medium',
        notes: (input.notes as string) ?? '',
      }
      if (input.due_date) reminder.dueDate = input.due_date
      const remAssignee = resolveMemberRef(ctx.members ?? [], (input.assignee as string) ?? (input.assignee_email as string))
      if (remAssignee) {
        reminder.assigneeId = remAssignee.id
        if (remAssignee.email) reminder.assigneeEmail = remAssignee.email
      } else if (input.assignee_email) {
        reminder.assigneeEmail = input.assignee_email
      }
      await col('reminders').doc(id).set(reminder)
      actions.push(`Created reminder: ${reminder.title as string}`)
      return { success: true, id, reminder }
    }

    case 'remember': {
      if (!db) return { error: 'Firestore admin not configured. Cannot save memory.' }
      const id = generateId()
      const memory: Record<string, unknown> = {
        text: input.text as string,
        source: 'ai',
        createdAt: new Date().toISOString(),
      }
      if (input.category) memory.category = input.category
      if (input.subject_email) memory.subjectEmail = input.subject_email
      await col('memories').doc(id).set(memory)
      actions.push(`Remembered: ${memory.text as string}`)
      return { success: true, id, memory }
    }

    case 'forget': {
      if (!db) return { error: 'Firestore admin not configured. Cannot update memory.' }
      const memId = input.id as string
      if (!memId) return { error: 'No memory id provided.' }
      const ref = col('memories').doc(memId)
      const snap = await ref.get()
      if (!snap.exists) return { error: `Memory ${memId} not found (it may already be gone).` }
      const text = (snap.data()?.text as string) ?? ''
      await ref.delete()
      actions.push(`Forgot: ${text}`)
      return { success: true, id: memId }
    }

    case 'create_chore': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create chore.' }
      const id = generateId()
      const frequency = (input.frequency as string) ?? 'weekly'
      const choreAssignee = resolveMemberRef(ctx.members ?? [], (input.assignee as string) ?? (input.assignee_email as string))
      const chore: Record<string, unknown> = {
        name: input.name as string,
        assigneeEmail: choreAssignee?.email || (input.assignee_email as string) || '',
        colorHex: choreAssignee?.colorHex || '#22C55E',
        recurrence: {
          frequency: ['daily', 'weekly', 'monthly'].includes(frequency) ? frequency : 'weekly',
          interval: (input.interval as number) ?? 1,
        },
        streak: 0,
      }
      if (choreAssignee) chore.assigneeId = choreAssignee.id
      await col('chores').doc(id).set(chore)
      actions.push(`Created chore: ${chore.name}`)
      return { success: true, id, chore }
    }

    case 'create_shopping_list': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create shopping list.' }
      const id = generateId()
      const list = {
        name: input.name as string,
        store: (input.store as string) ?? '',
        colorHex: '#8B5CF6',
        items: [],
      }
      await col('shopping_lists').doc(id).set(list)
      actions.push(`Created shopping list: ${list.name}`)
      return { success: true, id, list }
    }

    case 'add_shopping_items': {
      if (!db) return { error: 'Firestore admin not configured. Cannot add shopping items.' }
      const listId = input.list_id as string
      const listRef = col('shopping_lists').doc(listId)
      const listSnap = await listRef.get()
      if (!listSnap.exists) return { error: `Shopping list ${listId} not found` }

      const existing = listSnap.data() as { items: unknown[] }
      const newItems = (input.items as Array<{
        name: string
        quantity?: number
        unit?: string
        category?: string
      }>).map((item) => ({
        id: generateId(),
        name: item.name,
        quantity: item.quantity ?? 1,
        unit: item.unit ?? '',
        category: item.category ?? 'Other',
        isPurchased: false,
      }))

      await listRef.update({ items: [...(existing.items ?? []), ...newItems] })
      const itemNames = newItems.map((i) => i.name).join(', ')
      actions.push(`Added to shopping: ${itemNames}`)
      return { success: true, added: newItems }
    }

    case 'create_checklist': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create checklist.' }
      const id = generateId()
      const checklist = {
        name: input.name as string,
        colorHex: '#3B82F6',
        createdAt: new Date().toISOString(),
        items: [],
      }
      await col('checklists').doc(id).set(checklist)
      actions.push(`Created checklist: ${checklist.name}`)
      return { success: true, id, checklist }
    }

    case 'add_checklist_items': {
      if (!db) return { error: 'Firestore admin not configured. Cannot add checklist items.' }
      const checklistId = input.checklist_id as string
      const checklistRef = col('checklists').doc(checklistId)
      const checklistSnap = await checklistRef.get()
      if (!checklistSnap.exists) return { error: `Checklist ${checklistId} not found` }

      const existing = checklistSnap.data() as { items: unknown[] }
      const newItems = (input.items as string[]).map((title) => ({
        id: generateId(),
        title,
        isCompleted: false,
      }))

      await checklistRef.update({ items: [...(existing.items ?? []), ...newItems] })
      actions.push(`Added ${newItems.length} item(s) to checklist`)
      return { success: true, added: newItems }
    }

    case 'set_meal': {
      if (!db) return { error: 'Firestore admin not configured. Cannot set meal plan.' }
      const date = input.date as string
      // Use date as doc ID for easy lookup
      const id = date.replace(/-/g, '')
      const meal = {
        id,
        date,
        mealName: input.meal_name as string,
        ingredients: (input.ingredients as string[]) ?? [],
        notes: (input.notes as string) ?? '',
      }
      await col('meal_plans').doc(id).set(meal)
      actions.push(`Set meal for ${date}: ${meal.mealName}`)
      return { success: true, id, meal }
    }

    case 'complete_reminder': {
      if (!db) return { error: 'Firestore admin not configured. Cannot complete reminder.' }
      const reminderId = input.reminder_id as string
      await col('reminders').doc(reminderId).update({
        isCompleted: true,
        completedAt: new Date().toISOString(),
      })
      actions.push(`Completed reminder: ${reminderId}`)
      return { success: true }
    }

    case 'complete_chore': {
      if (!db) return { error: 'Firestore admin not configured. Cannot complete chore.' }
      const choreId = input.chore_id as string
      const choreRef = col('chores').doc(choreId)
      const choreSnap = await choreRef.get()
      if (!choreSnap.exists) return { error: `Chore ${choreId} not found` }

      const chore = choreSnap.data() as { streak?: number; name?: string }
      const streak = (chore.streak ?? 0) + 1
      await choreRef.update({
        lastCompletedDate: new Date().toISOString().split('T')[0],
        streak,
      })
      actions.push(`Completed chore: ${chore.name ?? choreId} (streak: ${streak})`)
      return { success: true, streak }
    }

    // -----------------------------------------------------------------------
    // GOOGLE CALENDAR TOOLS
    // -----------------------------------------------------------------------
    case 'list_google_calendars': {
      if (!googleTokens) return { error: 'Google Calendar not connected' }
      const cals = await getCalendars(googleTokens.accessToken, googleTokens.refreshToken)
      return {
        calendars: cals.map((c) => ({
          id: c.id,
          name: c.summary,
          primary: c.primary ?? false,
          accessRole: c.accessRole,
        })),
      }
    }

    case 'get_google_events': {
      if (!googleTokens) return { error: 'Google Calendar not connected' }
      const daysAhead = (input.days_ahead as number) ?? 14
      const now = new Date()
      const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)
      const events = await getEvents(
        googleTokens.accessToken,
        googleTokens.refreshToken,
        now.toISOString(),
        future.toISOString(),
      )
      return { events }
    }

    case 'create_google_event': {
      if (!googleTokens) return { error: 'Google Calendar not connected' }
      const isAllDay = input.is_all_day as boolean ?? !input.start_datetime.includes('T')
      const created = await createGoogleEvent(
        googleTokens.accessToken,
        googleTokens.refreshToken,
        {
          title: input.title as string,
          start: input.start_datetime as string,
          end: input.end_datetime as string,
          isAllDay,
          location: input.location as string | undefined,
          notes: input.notes as string | undefined,
          timezone: ctx.timezone,
          calendarId: input.calendar_id as string | undefined,
        },
      )
      actions.push(`Created Google Calendar event: ${created.title} on ${created.start.split('T')[0]}`)
      return { success: true, event: created }
    }

    case 'delete_google_event': {
      if (!googleTokens) return { error: 'Google Calendar not connected' }
      const calId = (input.calendar_id as string) || 'primary'
      await deleteEvent(googleTokens.accessToken, googleTokens.refreshToken, input.event_id as string, calId)
      actions.push(`Deleted Google Calendar event: ${input.event_title ?? input.event_id}`)
      return { success: true }
    }

    case 'update_google_event': {
      if (!googleTokens) return { error: 'Google Calendar not connected' }
      const calId = (input.calendar_id as string) || 'primary'
      // For scope "all" on a recurring series, patch the series event ID so all occurrences change.
      const scope = (input.scope as string) ?? 'instance'
      const targetId = scope === 'all' && input.series_event_id
        ? (input.series_event_id as string)
        : (input.event_id as string)
      const updates: { title?: string; start?: string; end?: string; location?: string; notes?: string; timezone?: string } = {}
      if (input.title) updates.title = input.title as string
      if (input.start_datetime) updates.start = input.start_datetime as string
      if (input.end_datetime) updates.end = input.end_datetime as string
      if (input.location !== undefined) updates.location = input.location as string
      if (input.notes !== undefined) updates.notes = input.notes as string
      if (ctx.timezone) updates.timezone = ctx.timezone
      const updated = await updateEvent(googleTokens.accessToken, googleTokens.refreshToken, targetId, calId, updates)
      const scopeLabel = scope === 'all' ? ' (all occurrences)' : ''
      actions.push(`Updated Google Calendar event: ${updated.title}${scopeLabel}`)
      return { success: true, event: updated, scope }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}
