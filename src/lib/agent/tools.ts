import Anthropic from '@anthropic-ai/sdk'
import { generateId } from '@/lib/utils'
import { getEvents, getCalendars, createEvent as createGoogleEvent, updateEvent, deleteEvent } from '@/lib/google/calendar'
import { resolveMemberRef } from '@/lib/members'
import type { FamilyMember, FamilyMemory, FamilyProfile } from '@/lib/types'
import { memorySubjects } from '@/lib/types'

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
    name: 'list_tasks',
    description: 'Get the family To Do list (tasks). Use this to see what tasks exist before creating new ones or when the user asks about their task list.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_completed: {
          type: 'boolean',
          description: 'Whether to include completed tasks (default false)',
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
  {
    name: 'get_member_profile',
    description: "Get the structured profile data stored directly on a family member — their importantInfo (medical, education, logistics, personal), routines, preferences, and profile notes. Call this BEFORE update_member_info or remove_member_info to see what already exists (so you don't add duplicates or use stale IDs).",
    input_schema: {
      type: 'object' as const,
      properties: {
        member_name: { type: 'string', description: "Exact name of the family member (e.g. 'Maddie', 'Eric')" },
      },
      required: ['member_name'],
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
          description: 'End datetime as ISO 8601 string or date only. CRITICAL FOR ALL-DAY EVENTS — end date is EXCLUSIVE (not included). Set end to the day AFTER the last day: a Mon–Fri event needs end = Saturday, not Friday.',
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
        related_event_id: { type: 'string', description: 'Optional. If this reminder is FOR or ABOUT a specific calendar event you already looked up (e.g. "buy flowers for the recital"), pass that event\'s id here so the two are explicitly linked. ONLY set this when the connection is a fact from the conversation — never guess. Use the event id from list_events / get_google_events.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a task in the family To Do list. Use this for action items that belong in the task list (not calendar events or reminders). Tasks support "assignee" (who is responsible) and "for_member_names" (who the task is about — e.g. a task for a child).',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        priority: { type: 'string', description: 'Priority: none, low, medium, or high (default: none)' },
        due_date: { type: 'string', description: 'Optional due date as ISO date string (e.g. 2024-03-15)' },
        assignee: { type: 'string', description: 'Optional NAME of the family member responsible for this task' },
        for_member_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of family member NAMES who this task is FOR or ABOUT (e.g. ["Maddie"] for a task about Maddie\'s appointment). Different from assignee — assignee is who does it, "for" is who it concerns.',
        },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update an existing task. Call list_tasks first to get the task id. Only pass fields you want to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'ID of the task to update' },
        title: { type: 'string', description: 'New title (omit to leave unchanged)' },
        priority: { type: 'string', description: 'New priority: none, low, medium, or high (omit to leave unchanged)' },
        due_date: { type: 'string', description: 'New due date as ISO date string, or empty string "" to clear it (omit to leave unchanged)' },
        assignee: { type: 'string', description: 'NAME of the new assignee, or empty string "" to unassign (omit to leave unchanged)' },
        for_member_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of member names this task is FOR/ABOUT, or empty array [] to clear (omit to leave unchanged)',
        },
        notes: { type: 'string', description: 'New notes (omit to leave unchanged)' },
        is_completed: { type: 'boolean', description: 'Set true to mark complete, false to reopen (omit to leave unchanged)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as complete. Call list_tasks first to get the task id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'ID of the task to complete' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task permanently. Call list_tasks first to get the task id. Use complete_task instead if the user just wants to check it off.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'ID of the task to delete' },
      },
      required: ['task_id'],
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
          description: 'End datetime in LOCAL time as YYYY-MM-DDTHH:mm:ss (no Z suffix). For all-day use YYYY-MM-DD.\n\nCRITICAL FOR ALL-DAY EVENTS — Google Calendar end dates are EXCLUSIVE (the end date is NOT included in the event). You must set end_datetime to the day AFTER the last day you want the event to cover:\n- Event on Monday only → end = Tuesday\n- Event Monday through Friday → end = Saturday (NOT Friday)\n- Event June 1–5 → end = June 6\nIf you set end = Friday for a Mon–Fri event, Google will show it as Mon–Thu. Always add 1 day to the last intended day.',
        },
        is_all_day: { type: 'boolean', description: 'Whether the event is all-day' },
        location: { type: 'string', description: 'Optional location' },
        notes: { type: 'string', description: 'Optional notes/description' },
        calendar_id: { type: 'string', description: 'Google Calendar ID to create the event in. Use list_google_calendars first to find the right ID when the user specifies a named calendar. Defaults to the primary calendar if omitted.' },
        recurrence: {
          type: 'array',
          items: { type: 'string' },
          description: 'RFC 5545 recurrence rules for repeating events. Pass a single RRULE string in the array. Common patterns:\n- Every weekday (Mon-Fri): ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]\n- Every week on a specific day: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] (change MO to TU/WE/TH/FR/SA/SU)\n- Every day: ["RRULE:FREQ=DAILY"]\n- Mon/Wed/Fri: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]\n- Every 2 weeks: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"]\n- N times only: append ";COUNT=N" e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"]\n- Until a date: append ";UNTIL=YYYYMMDD" e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231"]\nIMPORTANT: ALWAYS use recurrence for any request involving "Mon-Fri", "every week", "daily", "weekdays", etc. NEVER create separate individual events for each day — that is unreliable and will produce the wrong count.',
        },
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
    description: "Store or UPDATE a durable fact about the family so it informs future briefings and answers. Use this whenever the user tells you something worth remembering long-term — an allergy, a routine, a preference, a relationship, a recurring logistic. Do NOT use it for one-off tasks or events (use create_reminder/create_event for those).\n\nTO UPDATE A FACT YOU ALREADY KNOW: pass the existing memory's id in `replaces`. This overwrites it in place — do NOT call forget first, and do NOT create a second memory. Each memory in your context is labelled with [id:xxx]; use that id. Updating (not duplicating) is critical — two contradictory facts about the same thing make every future briefing wrong.",
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact to remember, phrased as a complete, standalone statement that includes ALL the details needed to be useful on its own — day, time, place, and person where relevant. A memory like "therapy is at 3pm" is dangerously incomplete because it omits the day, forcing future readers to guess. Prefer "Maddie\'s therapy with Jamie is on Thursdays at 3pm (session starts 3:15pm)". When the fact includes a specific date, store it as YYYY-MM-DD rather than a day name (e.g. "Maddie\'s grounding ends 2026-06-28" not "ends Sunday June 28"). If you only know part of a fact, include an explicit note about what is unknown (e.g. "Maddie\'s therapy is at 3pm — day of week not confirmed").' },
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'routine', 'health', 'logistics', 'relationship', 'other'],
          description: 'Best-fit category for the fact',
        },
        subject_email: { type: 'string', description: "Email of the family member this fact is about, if it's about a specific person" },
        replaces: { type: 'string', description: 'Optional. The id of an existing memory this fact UPDATES or CORRECTS (from the [id:xxx] label in your context). When set, that memory is overwritten in place instead of a new one being created. Use this whenever a fact changes (a grounding extended, a routine altered, a preference flipped) so you never leave a stale, contradictory copy behind.' },
        expires_at: { type: 'string', description: 'Optional. For TIME-BOUND facts only, the date (YYYY-MM-DD) after which this fact is no longer true and should stop influencing briefings — e.g. a grounding end date, a temporary illness, a visiting relative\'s departure. After this date the memory is automatically dropped. OMIT for permanent facts (allergies, relationships, standing routines).' },
        related_event_id: { type: 'string', description: 'Optional. If this fact is specifically ABOUT a calendar event you already looked up (e.g. a note clarifying what an event is), pass that event\'s id to link them. ONLY when it\'s an explicit fact — never guess.' },
        related_task_id: { type: 'string', description: 'Optional. If this fact is specifically ABOUT a reminder/task you already looked up, pass that task/reminder id to link them. ONLY when it\'s an explicit fact — never guess.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'relate',
    description: "Create, change, or remove the explicit link between two items the family already has — use this to FIX connections when the user tells you the real story (e.g. \"that flowers reminder is actually for the OTHER recital\", or \"that note isn't about the dentist appointment\"). Links are how you avoid guessing what relates to what. Look up the item ids first with the list tools. To REMOVE a link, pass an empty string for the target id.",
    input_schema: {
      type: 'object' as const,
      properties: {
        item_type: { type: 'string', enum: ['reminder', 'memory'], description: 'The type of the item that HOLDS the link (a reminder or a memory).' },
        item_id: { type: 'string', description: 'The id of the reminder or memory to update (from the list tools / [id:xxx] labels).' },
        related_event_id: { type: 'string', description: 'The calendar event id to link this item to. Pass an empty string "" to REMOVE an existing event link. Omit if not changing the event link.' },
        related_task_id: { type: 'string', description: 'For memories only: the reminder/task id to link this memory to. Pass empty string "" to remove. Omit if not changing.' },
      },
      required: ['item_type', 'item_id'],
    },
  },
  {
    name: 'forget',
    description: "Permanently delete a durable memory that should no longer exist at all (e.g. it was wrong, or is irrelevant going forward). NOTE: if you're UPDATING a fact rather than removing it (a grounding gets extended, a routine changes, a preference flips), do NOT forget-then-remember — instead call remember with `replaces` set to the old memory's id, which overwrites it in one step. Use forget only for genuine deletions. Each memory in your context is labelled with [id:xxx]; pass that id here.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The id of the memory to delete (from the [id:xxx] label in your context)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_web',
    description: 'Search the web for real-time information not available in the family\'s data — e.g. package tracking status, business hours, weather, news, recipes, product info. Use whenever the user asks about something that requires up-to-date external information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query. Be specific — include tracking numbers, addresses, dates, or other relevant details so results are accurate.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_member_info',
    description: "Add or update a structured fact directly on a family member's profile — their medical info, routines, preferences, or personal notes. Use this instead of remember() for personal facts ABOUT a specific person. The data appears on their profile card in the app and feeds into their personal AI context.\n\nCall get_member_profile first to see what already exists so you don't add duplicates.\n\nField types:\n- 'importantInfo': structured facts — medical devices, allergies, school, doctors, logistics (provide category + label + value)\n- 'routine': a recurring schedule item — 'Soccer practice Tue/Thu 5pm', 'School pickup 3:30pm' (provide title + schedule + optional notes)\n- 'preference': something they like or dislike — 'Food: loves tacos', 'Dislikes: loud noises' (provide category + text)\n- 'note': a freeform personal note that doesn't fit the above (provide text only)",
    input_schema: {
      type: 'object' as const,
      properties: {
        member_name: { type: 'string', description: "Name of the family member to update (e.g. 'Maddie')" },
        field: {
          type: 'string',
          enum: ['importantInfo', 'routine', 'preference', 'note'],
          description: "Which profile field to add/update",
        },
        // importantInfo fields
        category: {
          type: 'string',
          enum: ['medical', 'education', 'logistics', 'personal', 'other'],
          description: "Category for importantInfo items. 'medical' for health/devices/allergies/medications/doctors. 'education' for school/teachers/grade. 'logistics' for practical facts (bus stop, locker combo). 'personal' for personal details. Required when field='importantInfo'.",
        },
        label: { type: 'string', description: "Short label/key for importantInfo — e.g. 'Insulin pump', 'Allergies', 'Pediatrician', 'School'. Required when field='importantInfo'." },
        value: { type: 'string', description: "The full value for importantInfo — e.g. 'Tandem Mobi with SteadiSet infusion sets', 'Peanuts (EpiPen required)'. Required when field='importantInfo'." },
        // routine fields
        title: { type: 'string', description: "Routine name — e.g. 'Soccer practice', 'School pickup'. Required when field='routine'." },
        schedule: { type: 'string', description: "Human-readable schedule — e.g. 'Tue/Thu 5–6pm', 'Weekdays 3:30pm'. Required when field='routine'." },
        notes: { type: 'string', description: "Optional extra notes for a routine — e.g. 'Parent must stay', 'Bring water bottle'." },
        // preference fields
        pref_category: { type: 'string', description: "Preference category — e.g. 'Food', 'Activities', 'Dislikes', 'Comfort'. Required when field='preference'." },
        text: { type: 'string', description: "Preference text — e.g. 'Loves tacos and pizza', 'Hates loud noises'. Required when field='preference' or field='note'." },
        // update existing
        replaces_id: { type: 'string', description: "ID of an existing item to replace/update in place (from get_member_profile). Omit to add a new item. Use this when a fact has changed — e.g. a new doctor, a different infusion set — so you don't leave a stale copy." },
      },
      required: ['member_name', 'field'],
    },
  },
  {
    name: 'remove_member_info',
    description: "Remove a specific item from a family member's profile (importantInfo, routine, preference, or note). Call get_member_profile first to get the exact item ID.",
    input_schema: {
      type: 'object' as const,
      properties: {
        member_name: { type: 'string', description: "Name of the family member" },
        field: {
          type: 'string',
          enum: ['importantInfo', 'routine', 'preference', 'note'],
          description: "Which profile field to remove from",
        },
        item_id: { type: 'string', description: "ID of the item to remove (from get_member_profile)" },
      },
      required: ['member_name', 'field', 'item_id'],
    },
  },
  {
    name: 'add_briefing_rule',
    description: "Add a hard behavioral rule to the family's briefing rules. Use this when the user tells you to ALWAYS or NEVER do something about how the briefing is presented — e.g. 'always put swim lessons under each child, not Family', 'never suggest creating reminders for things already in my task list', 'group Liam's therapy under Liam, not Family'. These rules are injected into every future briefing as authoritative hard constraints that override all other AI guidance. Use this sparingly — only for genuine, durable presentation preferences the user wants enforced every time, not for one-off requests.",
    input_schema: {
      type: 'object' as const,
      properties: {
        rule: {
          type: 'string',
          description: "The rule as a complete, standalone instruction. Write it as a direct behavioral command that will make sense on its own in future briefings — e.g. 'When Rowan and Faylen share an activity (like swim lessons), create one card per child, each under their own section. Never collapse shared sibling activities into the Family section.' Be specific: name the people, activity, or pattern involved so the rule is unambiguous."
        },
      },
      required: ['rule'],
    },
  },
  {
    name: 'remove_briefing_rule',
    description: "Remove a hard behavioral rule from the family's briefing rules. Use this when the user says a rule is no longer needed, is wrong, or they want to change how something is presented. First call list_briefing_rules to see the exact text of the rule to remove.",
    input_schema: {
      type: 'object' as const,
      properties: {
        rule: {
          type: 'string',
          description: 'The exact text of the rule to remove (must match exactly what was stored — use list_briefing_rules to get the exact text first).',
        },
      },
      required: ['rule'],
    },
  },
  {
    name: 'list_briefing_rules',
    description: "List all hard behavioral rules the family has set for how the briefing should be presented. Check this before adding a new rule (to avoid duplicates) or before removing one (to get the exact text).",
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

// Tools that mutate data — these require explicit user confirmation before
// they are actually executed. Read tools run freely so the AI can gather
// context and produce an accurate preview of what it intends to do.
export const WRITE_TOOLS = new Set<string>([
  'create_event',
  'create_reminder',
  'create_task',
  'update_task',
  'complete_task',
  'delete_task',
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
  'relate',
  'add_briefing_rule',
  'remove_briefing_rule',
  'update_member_info',
  'remove_member_info',
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

CREATING RECURRING EVENTS: Whenever the user says "every day", "Mon-Fri", "every week", "weekdays", "every Monday", or any other repeating pattern, ALWAYS use the recurrence parameter — NEVER create separate events for each day. Creating individual events is unreliable: the AI miscounts dates. The recurrence parameter uses Google Calendar's native RRULE format. Key patterns (memorize these):
- "Monday through Friday" / "weekdays" / "Mon-Fri" → recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]
- "every day" → recurrence: ["RRULE:FREQ=DAILY"]
- "every Monday" → recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
- "Mon/Wed/Fri" → recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]
- "every 2 weeks on Tuesday" → recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"]
- Add COUNT to limit: "for 4 weeks Mon-Fri" → RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20
- Add UNTIL to end on a date: append ;UNTIL=YYYYMMDD (e.g. UNTIL=20261231)
The start_datetime for a recurring event is just the FIRST occurrence. Google Calendar generates all future instances automatically.

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
        .map((m) => {
          const subs = memorySubjects(m)
          return `- [id:${m.id}] ${m.category ? `[${m.category}] ` : ''}${m.text}${subs.length ? ` (about ${subs.join(', ')})` : ''}`
        })
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
DATE VALIDATION RULE: Before quoting any date to the user — whether from memory, a reminder, or an event — look up the exact date in the DAY-DATE REFERENCE table above and use the day name from the table. Never trust a day name that was embedded in stored text; dates can outlive the day name that was written alongside them (e.g. a memory saying "Sunday, June 22" is wrong if the table shows June 22 is Monday). Always show the corrected day name.
CONFLICT DETECTION RULE: If you notice two memories that directly contradict each other about the same fact (e.g., two different end dates for the same grounding, two different school schedules), do not pick one silently. Tell the user there are conflicting entries, show both, ask which is correct, then call remember with the "replaces" field set to the stale memory's id to overwrite it with the confirmed fact in one step (do NOT forget-then-remember, which risks leaving a duplicate behind).
MEMORY UPDATE RULE: When a fact you already remember changes (a grounding extended, a routine moved, a preference flipped), UPDATE it in place — call remember with "replaces" set to that memory's [id:xxx]. Never create a second memory for a fact you already hold; duplicates make briefings contradict themselves. For genuinely TIME-BOUND facts (a grounding end date, a temporary illness, a visiting relative), set "expires_at" to the date it stops being true so it drops out of briefings automatically once it lapses — leave it off for permanent facts like allergies or relationships.
INFERENCE RULE (critical): A fact must be explicitly stated in a single source to be reported as true. Never combine two separate memories, events, or data points to infer a new fact that neither one states on its own. Common mistakes to avoid: (1) a memory gives a time but no day — do NOT borrow the day from a nearby memory about the same person; the day is unknown unless explicitly stated. (2) a memory mentions a place — do NOT assume other events involving that person also happen at that place. (3) two events happening at similar times — do NOT conclude they are the same event. If a piece of information is missing (e.g. day of week for a recurring appointment), say it is not in the data and ask the user rather than guessing. When you catch yourself about to combine two pieces of information, stop — state each piece separately and flag what is unknown.
LINKING RULE: When you create a reminder or a memory that is clearly FOR or ABOUT a specific calendar event (e.g. "buy flowers for Maddie's recital" → the recital event, or a note explaining what an event is), record that connection: look up the event id first, then pass related_event_id when you create_reminder or remember. This is how the family's data stays connected so future briefings don't have to guess what relates to what. CRITICAL: only set a link when the connection is an explicit fact from the conversation or the data — NEVER guess a link from coincidence (same day, same person is not enough). A wrong link is worse than no link. If the user later tells you a link is wrong ("that reminder is for the other recital", "that note isn't about the dentist"), use the relate tool to fix or remove it — you can always redo connections as the real story becomes clear.
All times you display to the user should be in ${timezone ? `the user's timezone (${timezone})` : 'local time'}, not UTC.
CRITICAL — when calling create_google_event or create_event, always use LOCAL datetime strings in the format YYYY-MM-DDTHH:mm:ss with NO "Z" suffix and NO timezone offset. "3pm" means ${timezone ?? 'local time'} 3pm, output as "YYYY-MM-DDTHH:15:00:00", not UTC.
ALL-DAY EVENT END DATES ARE EXCLUSIVE: For any all-day or date-only event, Google Calendar does NOT include the end date in the event display. A Mon–Fri event must have end_datetime = Saturday (the day after Friday). Single-day event on Tuesday must have end_datetime = Wednesday. Always add 1 calendar day to whatever the user says is the last day.

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
- CORRECT stale memory. When the user updates or contradicts something already in durable memory (e.g. "actually Maddie's grounding is extended to June 28" when memory says it ends June 22), queue a forget action for the old [id:xxx] AND a remember action for the corrected fact in the same turn. Never leave two contradictory memories on file — that makes briefings wrong. Match memories about a person even when tagged to that person, not just family-wide ones. When storing updated facts that include dates, store dates as YYYY-MM-DD without a day name (e.g. "Maddie's grounding ends 2026-06-28") so the fact stays accurate as time passes.
- PROFILE vs MEMORY: When saving a personal fact that is ABOUT a specific named family member, prefer update_member_info over remember. Use this decision rule:
  → update_member_info: health facts (medical devices, allergies, medications, doctors), school/education details, personal routines and schedules, preferences and dislikes — anything that belongs on THAT PERSON'S profile card. Call get_member_profile first to check what already exists and avoid duplicates; if something changed, pass replaces_id so the old entry is overwritten.
  → remember: family-wide facts (logistics everyone shares), relationships between people ("Maddie and Liam are both in the school play"), one-time events that have context beyond a single person, or facts that don't cleanly map to a profile field.
  If unsure: if a fact is primarily ABOUT one person and would make sense on their profile page, use update_member_info.

Examples of what you can do:
- "Add milk to shopping" → call list_shopping_lists to find the right list, then add_shopping_items (queued for confirmation)
- "Schedule dentist for Mia next Tuesday at 3pm" → create_event or create_google_event (queued for confirmation)
- "What do we have this week?" → get_google_events or list_events, summarize concisely
- "Add chicken tacos to Monday dinner" → set_meal (queued for confirmation)
- "Remind Eric to pay rent on the 1st" → create_reminder with assignee "Eric" (queued for confirmation)
- "What chores are due?" → list_chores
- "Add 'buy birthday gift for Grandma' to my to do list" → create_task (queued for confirmation)
- "What's on my task list?" → list_tasks, summarize concisely
- "Mark the grocery run task as done" → list_tasks to find id, then complete_task (queued for confirmation)
- "Change the priority of the dentist task to high" → list_tasks to find id, then update_task (queued for confirmation)

TASKS vs REMINDERS: Tasks live in the To Do list (list_tasks / create_task). Reminders are date-bound items (create_reminder). Use tasks for action items the user wants to track and check off; use reminders when there's a specific due date/time that matters and the user wants to be reminded. When in doubt, prefer tasks for general to-dos.

TASK "FOR" FIELD: Tasks support a "for_member_names" field — who the task is FOR or ABOUT. This is separate from "assignee" (who is responsible). Use for_member_names when a task concerns a specific family member who isn't necessarily the one doing it — e.g. "Schedule Maddie's dentist" → assignee could be a parent, for_member_names: ["Maddie"].

If the user asks to add something to shopping and no list exists yet, create one first with create_shopping_list, then add items with add_shopping_items — use the temporary id returned by create_shopping_list as the list_id for add_shopping_items.

BRIEFING RULES (hard behavioral rules for the briefing engine):
The family can set rules that control exactly how the daily briefing is presented — which section a person's card appears under, whether to group certain events together, what to never surface, etc. These rules are injected into every future briefing as authoritative hard constraints that override the briefing engine's defaults. You can read, add, and remove these rules.
- list_briefing_rules: see what rules are currently set
- add_briefing_rule: add a new rule when the user says "always do X" or "never do Y" about how the briefing is presented. Check for duplicates first.
- remove_briefing_rule: remove a rule when the user says a rule is wrong or no longer applies. Get the exact text with list_briefing_rules first.
When to add a rule: the user explicitly says they want the AI to ALWAYS or NEVER do something in the briefing (not a one-off request). Examples: "whenever Rowan and Faylen share swim lessons, put each under their own section", "don't recommend creating reminders for things already in my task list". Queue an add_briefing_rule action and explain to the user what rule you're adding.
When NOT to add a rule: one-off requests ("move this item to the top today"), corrections to specific data ("that event is Maddie's not Liam's" — use remember for that), or requests about tasks/events themselves (use the appropriate create/complete tools).`
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

    case 'list_tasks': {
      if (!db) return { error: 'Firestore admin not configured', tasks: [] }
      const includeCompleted = (input.include_completed as boolean) ?? false
      const snap = await col('tasks').get()
      let tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      if (!includeCompleted) {
        tasks = tasks.filter((t: Record<string, unknown>) => !t.isCompleted)
      }
      return { tasks }
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
      if (input.related_event_id) reminder.relatedEventId = input.related_event_id as string
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

    case 'create_task': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create task.' }
      const id = generateId()
      const priority = (input.priority as string) ?? 'none'
      const taskAssignee = resolveMemberRef(ctx.members ?? [], (input.assignee as string) ?? '')
      const forNames = (input.for_member_names as string[]) ?? []
      const forIds = forNames
        .map((n) => resolveMemberRef(ctx.members ?? [], n))
        .filter(Boolean)
        .map((m) => m!.id)
      const task: Record<string, unknown> = {
        title: input.title as string,
        isCompleted: false,
        priority: ['none', 'low', 'medium', 'high'].includes(priority) ? priority : 'none',
        notes: (input.notes as string) ?? '',
        source: 'ai',
        createdAt: new Date().toISOString(),
      }
      if (input.due_date) task.dueDate = input.due_date as string
      if (taskAssignee) {
        task.assigneeId = taskAssignee.id
        if (taskAssignee.email) task.assigneeEmail = taskAssignee.email
      }
      if (forIds.length) task.forIds = forIds
      await col('tasks').doc(id).set(task)
      actions.push(`Created task: ${task.title as string}`)
      return { success: true, id, task }
    }

    case 'update_task': {
      if (!db) return { error: 'Firestore admin not configured. Cannot update task.' }
      const taskId = input.task_id as string
      if (!taskId) return { error: 'No task_id provided.' }
      const taskRef = col('tasks').doc(taskId)
      const snap = await taskRef.get()
      if (!snap.exists) return { error: `Task ${taskId} not found.` }
      const existing = snap.data() as Record<string, unknown>
      const updates: Record<string, unknown> = {}
      if (input.title !== undefined) updates.title = input.title as string
      if (input.notes !== undefined) updates.notes = input.notes as string
      if (input.priority !== undefined) {
        const p = input.priority as string
        updates.priority = ['none', 'low', 'medium', 'high'].includes(p) ? p : 'none'
      }
      if (input.due_date !== undefined) updates.dueDate = (input.due_date as string) || null
      if (input.assignee !== undefined) {
        if (!input.assignee) {
          updates.assigneeId = null
          updates.assigneeEmail = null
        } else {
          const m = resolveMemberRef(ctx.members ?? [], input.assignee as string)
          if (m) {
            updates.assigneeId = m.id
            if (m.email) updates.assigneeEmail = m.email
          }
        }
      }
      if (input.for_member_names !== undefined) {
        const names = input.for_member_names as string[]
        const ids = names
          .map((n) => resolveMemberRef(ctx.members ?? [], n))
          .filter(Boolean)
          .map((m) => m!.id)
        updates.forIds = ids.length ? ids : null
      }
      if (input.is_completed !== undefined) {
        updates.isCompleted = input.is_completed as boolean
        if (input.is_completed) updates.completedAt = new Date().toISOString()
        else updates.completedAt = null
      }
      await taskRef.update(updates)
      const title = (existing.title as string) ?? taskId
      actions.push(`Updated task: ${title}`)
      return { success: true, id: taskId }
    }

    case 'complete_task': {
      if (!db) return { error: 'Firestore admin not configured. Cannot complete task.' }
      const taskId = input.task_id as string
      const taskRef = col('tasks').doc(taskId)
      const snap = await taskRef.get()
      if (!snap.exists) return { error: `Task ${taskId} not found.` }
      const title = (snap.data()?.title as string) ?? taskId
      await taskRef.update({ isCompleted: true, completedAt: new Date().toISOString() })
      actions.push(`Completed task: ${title}`)
      return { success: true }
    }

    case 'delete_task': {
      if (!db) return { error: 'Firestore admin not configured. Cannot delete task.' }
      const taskId = input.task_id as string
      const taskRef = col('tasks').doc(taskId)
      const snap = await taskRef.get()
      if (!snap.exists) return { error: `Task ${taskId} not found.` }
      const title = (snap.data()?.title as string) ?? taskId
      await taskRef.delete()
      actions.push(`Deleted task: ${title}`)
      return { success: true }
    }

    case 'remember': {
      if (!db) return { error: 'Firestore admin not configured. Cannot save memory.' }
      // When `replaces` is set we upsert in place (an update/correction) so we
      // never leave a stale, contradictory copy behind. Otherwise create fresh.
      const replacesId = (input.replaces as string) || ''
      let id = replacesId || generateId()
      let isUpdate = false
      let priorPinned = false
      if (replacesId) {
        const existing = await col('memories').doc(replacesId).get()
        if (existing.exists) {
          isUpdate = true
          priorPinned = existing.data()?.pinned === true // carry a user's pin across an update
        } else {
          id = generateId() // stale id from the model — fall back to creating new
        }
      }
      const memory: Record<string, unknown> = {
        text: input.text as string,
        source: 'ai',
        createdAt: new Date().toISOString(),
      }
      if (priorPinned) memory.pinned = true
      if (input.category) memory.category = input.category
      if (input.subject_email) memory.subjectEmail = input.subject_email
      if (input.expires_at) memory.expiresAt = input.expires_at as string
      if (input.related_event_id) memory.relatedEventId = input.related_event_id as string
      if (input.related_task_id) memory.relatedTaskId = input.related_task_id as string
      await col('memories').doc(id).set(memory)
      actions.push(`${isUpdate ? 'Updated memory' : 'Remembered'}: ${memory.text as string}`)
      return { success: true, id, memory, updated: isUpdate }
    }

    case 'relate': {
      if (!db) return { error: 'Firestore admin not configured. Cannot update link.' }
      const itemType = input.item_type as string
      const itemId = input.item_id as string
      if (!itemId) return { error: 'No item id provided.' }
      const collection = itemType === 'memory' ? 'memories' : 'reminders'
      const ref = col(collection).doc(itemId)
      const snap = await ref.get()
      if (!snap.exists) return { error: `${itemType} ${itemId} not found.` }
      // An empty string clears the link; a value sets it; omitted leaves it as-is.
      const updates: Record<string, unknown> = {}
      if (input.related_event_id !== undefined) {
        updates.relatedEventId = input.related_event_id === '' ? null : (input.related_event_id as string)
      }
      if (itemType === 'memory' && input.related_task_id !== undefined) {
        updates.relatedTaskId = input.related_task_id === '' ? null : (input.related_task_id as string)
      }
      if (Object.keys(updates).length === 0) return { error: 'No link fields to update.' }
      await ref.update(updates)
      const changed = Object.entries(updates)
        .map(([k, v]) => `${k}=${v === null ? 'cleared' : v}`)
        .join(', ')
      actions.push(`Updated link on ${itemType} ${itemId}: ${changed}`)
      return { success: true, id: itemId }
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
      const recurrence = Array.isArray(input.recurrence) ? (input.recurrence as string[]) : undefined
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
          recurrence,
        },
      )
      const recLabel = recurrence?.length ? ` (recurring: ${recurrence[0]})` : ''
      actions.push(`Created Google Calendar event: ${created.title} on ${created.start.split('T')[0]}${recLabel}`)
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

    case 'get_member_profile': {
      const targetMember = resolveMemberRef(ctx.members ?? [], input.member_name as string)
      if (!targetMember) return { error: `Member "${input.member_name}" not found.` }
      // Return all structured profile arrays with their IDs so the caller can reference them
      return {
        member: targetMember.name,
        importantInfo: targetMember.importantInfo ?? [],
        routines: targetMember.routines ?? [],
        preferences: targetMember.preferences ?? [],
        notes: targetMember.memories ?? [],
      }
    }

    case 'update_member_info': {
      if (!db) return { error: 'Firestore not configured.' }
      const targetMember = resolveMemberRef(ctx.members ?? [], input.member_name as string)
      if (!targetMember) return { error: `Member "${input.member_name}" not found.` }
      const memberRef = db.collection('families').doc(familyId).collection('members').doc(targetMember.id)
      const snap = await memberRef.get()
      if (!snap.exists) return { error: `Member ${targetMember.id} not found in Firestore.` }
      const data = snap.data() as Record<string, unknown>
      const field = input.field as string
      const replacesId = (input.replaces_id as string) || ''

      if (field === 'importantInfo') {
        const existing = (data.importantInfo as Array<{ id: string; category: string; label: string; value: string }>) ?? []
        const newItem = { id: replacesId || generateId(), category: (input.category as string) ?? 'other', label: input.label as string, value: input.value as string }
        const updated = replacesId ? existing.map((i) => i.id === replacesId ? newItem : i) : [...existing, newItem]
        await memberRef.update({ importantInfo: updated })
        actions.push(`Saved to ${targetMember.name}'s profile [${newItem.category}] ${newItem.label}: ${newItem.value}`)
        return { success: true, id: newItem.id }
      }

      if (field === 'routine') {
        const existing = (data.routines as Array<{ id: string; title: string; schedule: string; notes?: string }>) ?? []
        const newItem = { id: replacesId || generateId(), title: input.title as string, schedule: input.schedule as string, ...(input.notes ? { notes: input.notes as string } : {}) }
        const updated = replacesId ? existing.map((i) => i.id === replacesId ? newItem : i) : [...existing, newItem]
        await memberRef.update({ routines: updated })
        actions.push(`Saved to ${targetMember.name}'s routines: ${newItem.title} — ${newItem.schedule}`)
        return { success: true, id: newItem.id }
      }

      if (field === 'preference') {
        const existing = (data.preferences as Array<{ id: string; category: string; text: string }>) ?? []
        const newItem = { id: replacesId || generateId(), category: (input.pref_category as string) ?? 'other', text: input.text as string }
        const updated = replacesId ? existing.map((i) => i.id === replacesId ? newItem : i) : [...existing, newItem]
        await memberRef.update({ preferences: updated })
        actions.push(`Saved to ${targetMember.name}'s preferences [${newItem.category}]: ${newItem.text}`)
        return { success: true, id: newItem.id }
      }

      if (field === 'note') {
        const existing = (data.memories as Array<{ id: string; text: string; createdAt: string }>) ?? []
        const newItem = { id: replacesId || generateId(), text: input.text as string, createdAt: new Date().toISOString() }
        const updated = replacesId ? existing.map((i) => i.id === replacesId ? newItem : i) : [...existing, newItem]
        await memberRef.update({ memories: updated })
        actions.push(`Saved note to ${targetMember.name}'s profile: ${newItem.text}`)
        return { success: true, id: newItem.id }
      }

      return { error: `Unknown field type: ${field}` }
    }

    case 'remove_member_info': {
      if (!db) return { error: 'Firestore not configured.' }
      const targetMember = resolveMemberRef(ctx.members ?? [], input.member_name as string)
      if (!targetMember) return { error: `Member "${input.member_name}" not found.` }
      const memberRef = db.collection('families').doc(familyId).collection('members').doc(targetMember.id)
      const snap = await memberRef.get()
      if (!snap.exists) return { error: `Member ${targetMember.id} not found.` }
      const data = snap.data() as Record<string, unknown>
      const field = input.field as string
      const itemId = input.item_id as string

      const fieldKey = field === 'note' ? 'memories' : field === 'routine' ? 'routines' : field === 'preference' ? 'preferences' : 'importantInfo'
      const existing = (data[fieldKey] as Array<{ id: string }>) ?? []
      const filtered = existing.filter((i) => i.id !== itemId)
      if (filtered.length === existing.length) return { error: `Item ${itemId} not found in ${targetMember.name}'s ${field}.` }
      await memberRef.update({ [fieldKey]: filtered })
      actions.push(`Removed item from ${targetMember.name}'s ${field}`)
      return { success: true }
    }

    case 'list_briefing_rules': {
      if (!db) return { error: 'Firestore not configured.' }
      const famRef = db.collection('families').doc(familyId)
      const profSnap = await famRef.collection('profile').get()
      const profDoc = profSnap.docs[0]
      const rules: string[] = (profDoc?.data()?.briefingRules as string[]) ?? []
      return { rules }
    }

    case 'add_briefing_rule': {
      if (!db) return { error: 'Firestore not configured.' }
      const rule = (input.rule as string).trim()
      if (!rule) return { error: 'Rule text is empty.' }
      const famRef = db.collection('families').doc(familyId)
      const profSnap = await famRef.collection('profile').get()
      const profDoc = profSnap.docs[0]
      if (profDoc) {
        const existing: string[] = (profDoc.data()?.briefingRules as string[]) ?? []
        if (existing.includes(rule)) return { success: true, rule, note: 'Rule already exists.' }
        await profDoc.ref.update({ briefingRules: [...existing, rule] })
      } else {
        await famRef.collection('profile').add({ briefingRules: [rule] })
      }
      actions.push(`Added briefing rule: ${rule}`)
      return { success: true, rule }
    }

    case 'remove_briefing_rule': {
      if (!db) return { error: 'Firestore not configured.' }
      const ruleToRemove = (input.rule as string).trim()
      const famRef = db.collection('families').doc(familyId)
      const profSnap = await famRef.collection('profile').get()
      const profDoc = profSnap.docs[0]
      if (!profDoc) return { error: 'No profile found — no rules to remove.' }
      const existing: string[] = (profDoc.data()?.briefingRules as string[]) ?? []
      const filtered = existing.filter((r) => r !== ruleToRemove)
      if (filtered.length === existing.length) return { error: `Rule not found: "${ruleToRemove}". Use list_briefing_rules to see exact text.` }
      await profDoc.ref.update({ briefingRules: filtered })
      actions.push(`Removed briefing rule: ${ruleToRemove}`)
      return { success: true }
    }

    case 'search_web': {
      const apiKey = process.env.TAVILY_API_KEY
      if (!apiKey) return { error: 'Web search is not configured (TAVILY_API_KEY missing).' }
      const query = input.query as string
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        }),
      })
      if (!res.ok) return { error: `Web search failed: HTTP ${res.status}` }
      const data = await res.json() as {
        answer?: string
        results?: Array<{ title: string; url: string; content: string }>
      }
      return {
        answer: data.answer ?? null,
        results: (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        })),
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}
