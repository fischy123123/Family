import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { generateId } from '@/lib/utils'
import { getEvents, createEvent as createGoogleEvent } from '@/lib/google/calendar'
import type { FamilyMember } from '@/lib/types'

const AI_MODEL = 'claude-sonnet-4-6'

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
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
        assignee_email: { type: 'string', description: 'Optional email of the family member this is for' },
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
        assignee_email: { type: 'string', description: 'Optional email of who this is assigned to' },
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
        assignee_email: { type: 'string', description: 'Email of family member assigned to this chore' },
        frequency: { type: 'string', description: 'Recurrence frequency: daily, weekly, or monthly' },
        interval: { type: 'number', description: 'Interval for recurrence (e.g. 2 for every 2 weeks). Default 1.' },
      },
      required: ['name', 'assignee_email', 'frequency'],
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
          description: 'Start datetime as ISO 8601 string (e.g. 2024-03-15T14:00:00) or date only for all-day',
        },
        end_datetime: {
          type: 'string',
          description: 'End datetime as ISO 8601 string or date only',
        },
        is_all_day: { type: 'boolean', description: 'Whether the event is all-day' },
        location: { type: 'string', description: 'Optional location' },
        notes: { type: 'string', description: 'Optional notes/description' },
      },
      required: ['title', 'start_datetime', 'end_datetime'],
    },
  },
]

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  members: FamilyMember[],
  today: string,
  hasGoogleTokens: boolean,
): string {
  const memberList = members
    .map((m) => `  - ${m.name} (${m.email}, ${m.role})`)
    .join('\n')

  const calendarInstructions = hasGoogleTokens
    ? 'Google Calendar is connected — prefer get_google_events and create_google_event for calendar operations. Use list_events / create_event only for Firestore-only storage.'
    : 'Google Calendar is not connected — use list_events and create_event for Firestore-based calendar.'

  return `You are the Family Command Center assistant.
Today is ${today}.

Family members:
${memberList || '  (none yet)'}

${calendarInstructions}

Be concise and action-oriented. When the user asks you to add, create, or schedule something, do it immediately using the available tools and confirm what you did. Don't ask for confirmation unless something is genuinely ambiguous (e.g. the request mentions a person not in the family roster, or a date is completely unclear).

When listing events or data, be brief — use bullet points, not paragraphs.

Examples of what you can do:
- "Add milk to shopping" → call list_shopping_lists to find the right list, then add_shopping_items
- "Schedule dentist for Mia next Tuesday at 3pm" → create_event or create_google_event
- "What do we have this week?" → get_google_events or list_events, summarize concisely
- "Add chicken tacos to Monday dinner" → set_meal
- "Remind Eric to pay rent on the 1st" → create_reminder with Eric's email
- "What chores are due?" → list_chores

If the user asks to add something to shopping and no list exists yet, create one first with create_shopping_list, then add items with add_shopping_items.`
}

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

interface ToolContext {
  db: FirebaseFirestore.Firestore | null
  familyId: string
  userEmail: string
  googleTokens: { accessToken: string; refreshToken: string } | null
  actions: string[]
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<unknown> {
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

    // -----------------------------------------------------------------------
    // WRITE TOOLS
    // -----------------------------------------------------------------------
    case 'create_event': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create event.' }
      const id = generateId()
      const isAllDay = input.is_all_day as boolean ?? !input.start_datetime.includes('T')
      const event = {
        title: input.title as string,
        start: input.start_datetime as string,
        end: input.end_datetime as string,
        isAllDay,
        location: (input.location as string) ?? '',
        notes: (input.notes as string) ?? '',
        calendarId: 'primary',
        ownerEmail: (input.assignee_email as string) ?? ctx.userEmail,
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
      if (input.assignee_email) reminder.assigneeEmail = input.assignee_email
      await col('reminders').doc(id).set(reminder)
      actions.push(`Created reminder: ${reminder.title as string}`)
      return { success: true, id, reminder }
    }

    case 'create_chore': {
      if (!db) return { error: 'Firestore admin not configured. Cannot create chore.' }
      const id = generateId()
      const frequency = (input.frequency as string) ?? 'weekly'
      const chore = {
        name: input.name as string,
        assigneeEmail: (input.assignee_email as string) ?? '',
        colorHex: '#22C55E',
        recurrence: {
          frequency: ['daily', 'weekly', 'monthly'].includes(frequency) ? frequency : 'weekly',
          interval: (input.interval as number) ?? 1,
        },
        streak: 0,
      }
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
        },
      )
      actions.push(`Created Google Calendar event: ${created.title} on ${created.start.split('T')[0]}`)
      return { success: true, event: created }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const { messages, familyId, userEmail, googleTokens, context } = await request.json()

    if (!familyId) {
      return NextResponse.json({ error: 'familyId is required' }, { status: 400 })
    }

    // Firestore (may be null if service account not configured — read tools degrade gracefully)
    let db: FirebaseFirestore.Firestore | null = null
    try {
      const adminApp = getAdminApp()
      if (adminApp) {
        db = getFirestore(adminApp)
      }
    } catch {
      // db stays null; tools handle this gracefully
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
    }
    const anthropic = new Anthropic({ apiKey })

    const members: FamilyMember[] = context?.members ?? []
    const today: string = context?.today ?? new Date().toISOString()

    const systemPrompt = buildSystemPrompt(members, today, !!googleTokens)

    let conversationMessages: Anthropic.MessageParam[] = (messages ?? []).map(
      (m: { role: 'user' | 'assistant'; content: string }) => ({
        role: m.role,
        content: m.content,
      }),
    )

    // Only include Google tools if tokens are present
    const activeTools = googleTokens
      ? TOOLS
      : TOOLS.filter((t) => t.name !== 'get_google_events' && t.name !== 'create_google_event')

    const actions: string[] = []
    const toolCtx: ToolContext = { db, familyId, userEmail, googleTokens, actions }

    let reply = ''

    // Tool-use loop (max 5 iterations to prevent infinite loops)
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: activeTools,
        messages: conversationMessages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text')
        reply = textBlock?.type === 'text' ? textBlock.text : ''
        break
      }

      if (response.stop_reason === 'tool_use') {
        // Add assistant message (with tool_use blocks) to history
        const assistantMessage: Anthropic.MessageParam = {
          role: 'assistant',
          content: response.content,
        }
        conversationMessages.push(assistantMessage)

        // Execute each tool call
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          let result: unknown
          try {
            result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              toolCtx,
            )
          } catch (e: unknown) {
            result = { error: e instanceof Error ? e.message : String(e) }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        }

        conversationMessages.push({ role: 'user', content: toolResults })

        // If this is the last iteration, squeeze out a text reply
        if (i === 4) {
          const finalResponse = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 512,
            system: systemPrompt,
            tools: activeTools,
            messages: conversationMessages,
          })
          const textBlock = finalResponse.content.find((b) => b.type === 'text')
          reply = textBlock?.type === 'text' ? textBlock.text : 'Done.'
        }
        continue
      }

      // Unexpected stop reason (e.g. max_tokens mid-turn)
      const textBlock = response.content.find((b) => b.type === 'text')
      reply = textBlock?.type === 'text' ? textBlock.text : ''
      break
    }

    return NextResponse.json({ reply, actions })
  } catch (e: unknown) {
    console.error('[agent] error:', e)
    const msg = e instanceof Error ? e.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
