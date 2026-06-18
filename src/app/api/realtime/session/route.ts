import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { TOOLS, buildSystemPrompt } from '@/lib/agent/tools'
import type { FamilyMember, FamilyMemory, FamilyProfile } from '@/lib/types'

const REALTIME_MODEL = 'gpt-realtime'
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

  // Derive user's first name for personalized greeting.
  const currentMember = (members ?? []).find((m) => m.email === userEmail)
  const firstName = currentMember?.name?.split(' ')[0] ?? null

  // Pull the most relevant memories for the greeting hint (pinned first, then recent).
  const sortedMemories = [...memories].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  })
  const topMemories = sortedMemories.slice(0, 4).map((m) => m.text).filter(Boolean)

  const greetingInstruction = firstName
    ? `Open by greeting ${firstName} warmly and naturally by name — like a trusted assistant who already knows them. ${topMemories.length ? `You know things about their life: ${topMemories.join('; ')}. If any of this is timely or useful, weave it in naturally.` : ''} Keep it to one or two sentences. Then ask what you can help with today. Always in English.`
    : 'Greet the user warmly in one short sentence and ask how you can help. Always in English.'

  // Override the text-formatting guidance for a spoken conversation.
  const voicePrompt = `${basePrompt}

# THIS IS A LIVE VOICE CONVERSATION
CRITICAL LANGUAGE RULE: You MUST always respond in English only. Never switch to Arabic, French, Spanish, or any other language — regardless of names, locations, or any other content in the context. English only, always.

- You are speaking out loud. Ignore any earlier instructions about markdown, bullet points, bold, or headings — those are for text. Speak in natural, short, conversational sentences.
- Keep replies brief and to the point. Don't read long lists aloud — summarize.
- Say dates and times naturally ("this Friday at three", not "2026-06-19T15:00:00").
- PERSONALIZATION: You know this family well. ${firstName ? `Use ${firstName}'s first name naturally in conversation (don't overdo it). ` : ''}Reference what you know about their life and schedule when it adds value. Match their conversational tone — if they're casual and quick, be the same; if they're thoughtful, meet them there. Speak like a trusted assistant who knows them, not a generic AI encountering them for the first time.
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

  // GA Realtime API: create an ephemeral client secret. Config nests under
  // `session`; audio settings live under audio.input / audio.output.
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions: voicePrompt,
        tools: activeTools,
        tool_choice: 'auto',
        audio: {
          input: {
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
          },
          output: { voice: VOICE },
        },
      },
    }),
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`)
    return NextResponse.json({ error: msg }, { status: res.status })
  }

  const data = await res.json()
  // Token is the top-level `value` (starts with "ek_").
  return NextResponse.json({ clientSecret: data.value, model: REALTIME_MODEL, greetingInstruction })
}
