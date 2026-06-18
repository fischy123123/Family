import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { TOOLS, buildSystemPrompt } from '@/lib/agent/tools'
import type { FamilyMember, FamilyMemory, FamilyProfile } from '@/lib/types'

const REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17'
const VOICE = 'shimmer'

// ---------------------------------------------------------------------------
// Mints a short-lived OpenAI Realtime session token and configures it with the
// family's system prompt + tools. The browser uses the returned client_secret
// to open a WebRTC connection directly to OpenAI — the real API key never
// leaves the server.
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
  }

  const { familyId, userEmail, timezone, today, members, hasGoogleCalendar } =
    (await request.json()) as {
      familyId: string
      userEmail?: string
      timezone?: string
      today?: string
      members?: FamilyMember[]
      hasGoogleCalendar?: boolean
    }

  if (!familyId) {
    return NextResponse.json({ error: 'familyId is required' }, { status: 400 })
  }

  // Load durable memory + profile so the voice assistant knows the family.
  let memories: FamilyMemory[] = []
  let profile: FamilyProfile | null = null
  try {
    const adminApp = getAdminApp()
    if (adminApp) {
      const db = getFirestore(adminApp)
      const famRef = db.collection('families').doc(familyId)
      const [memSnap, profSnap] = await Promise.all([
        famRef.collection('memories').get(),
        famRef.collection('profile').get(),
      ])
      memories = memSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FamilyMemory)
      profile = profSnap.docs[0]
        ? ({ id: profSnap.docs[0].id, ...profSnap.docs[0].data() } as FamilyProfile)
        : null
    }
  } catch {
    /* non-fatal — proceed without memory */
  }

  const basePrompt = buildSystemPrompt(
    members ?? [],
    today ?? new Date().toISOString(),
    !!hasGoogleCalendar,
    userEmail,
    timezone,
    memories,
    profile,
  )

  // Override the text-formatting guidance for a spoken conversation.
  const voicePrompt = `${basePrompt}

# THIS IS A LIVE VOICE CONVERSATION
- You are speaking out loud. Ignore any earlier instructions about markdown, bullet points, bold, or headings — those are for text. Speak in natural, short, conversational sentences.
- Keep replies brief and to the point. Don't read long lists aloud — summarize.
- Say dates and times naturally ("this Friday at three", not "2026-06-19T15:00:00").
- IMPORTANT — confirmation before any change: Before you call any tool that creates, updates, deletes, or completes anything (events, reminders, chores, lists, checklists, meals, memories), first say out loud what you're about to do and wait for the user to confirm ("yes", "go ahead", etc.). Only after they confirm verbally should you call the write tool. Read-only tools (listing/looking things up) can be called freely without asking.`

  // Convert Anthropic-style tool defs to the Realtime API's function format.
  const activeTools = (hasGoogleCalendar
    ? TOOLS
    : TOOLS.filter((t) => !t.name.startsWith('get_google') && !t.name.startsWith('create_google') && !t.name.startsWith('update_google') && !t.name.startsWith('delete_google') && t.name !== 'list_google_calendars')
  ).map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }))

  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: REALTIME_MODEL,
      voice: VOICE,
      instructions: voicePrompt,
      tools: activeTools,
      tool_choice: 'auto',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
      input_audio_transcription: { model: 'whisper-1' },
    }),
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`)
    return NextResponse.json({ error: msg }, { status: res.status })
  }

  const session = await res.json()
  return NextResponse.json({ session, model: REALTIME_MODEL })
}
