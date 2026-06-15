import { NextRequest, NextResponse } from 'next/server'
import { getAnthropic, MODEL_DEEP } from '@/lib/ai'

interface Member {
  name?: string
  email?: string
}

function parseJSON<T>(text: string): T {
  const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (!match) throw new Error('AI did not return valid JSON')
  return JSON.parse(match[0]) as T
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured' },
      { status: 500 }
    )
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const mode = body.mode as string | undefined
  if (mode !== 'create' && mode !== 'assess') {
    return NextResponse.json(
      { error: 'mode must be "create" or "assess"' },
      { status: 400 }
    )
  }

  try {
    const anthropic = getAnthropic()

    if (mode === 'create') {
      const {
        title,
        kind,
        targetDate,
        notes,
        members = [],
        today,
      } = body as {
        title?: string
        kind?: string
        targetDate?: string
        notes?: string
        members?: Member[]
        today?: string
      }

      if (!title || !kind) {
        return NextResponse.json(
          { error: 'title and kind are required' },
          { status: 400 }
        )
      }

      const memberLines = (members ?? [])
        .map((m) => `- ${m.name ?? m.email ?? 'Member'}${m.email ? ` (${m.email})` : ''}`)
        .join('\n')

      const prompt = `You are an expert family planning assistant. Build a complete, practical plan skeleton.

PLAN
- Title: "${title}"
- Kind: ${kind}
- Target date: ${targetDate || 'not set'}
- Today: ${today || 'unknown'}
${notes ? `- Notes from the user: ${notes}` : ''}
${memberLines ? `Family members involved:\n${memberLines}` : ''}

Generate:
1. milestones: 3-7 key checkpoints. Each has a "title" and a "date" (ISO YYYY-MM-DD). Work BACKWARD from the target date so the final milestone lands on or near the target date and earlier prep happens sooner. If no target date, space milestones sensibly starting from today.
2. tasks: 6-15 concrete to-do items appropriate for this kind of plan. Each has a "title".
3. shopping: 0-12 items to buy if relevant for this kind of plan (e.g. trips/birthdays/holidays/home-projects). Each has a "name" and optional integer "quantity". Use an empty array if shopping is not relevant.
4. summary: one warm, concise sentence describing the plan.

Return ONLY valid JSON in exactly this shape:
{"milestones":[{"title":"...","date":"YYYY-MM-DD"}],"tasks":[{"title":"..."}],"shopping":[{"name":"...","quantity":1}],"summary":"..."}`

      const response = await anthropic.messages.create({
        model: MODEL_DEEP,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      })

      const text =
        response.content[0]?.type === 'text' ? response.content[0].text : ''
      const result = parseJSON<{
        milestones?: { title: string; date?: string }[]
        tasks?: { title: string }[]
        shopping?: { name: string; quantity?: number }[]
        summary?: string
      }>(text)

      return NextResponse.json({
        milestones: result.milestones ?? [],
        tasks: result.tasks ?? [],
        shopping: result.shopping ?? [],
        summary: result.summary ?? '',
      })
    }

    // mode === 'assess'
    const {
      title,
      kind,
      targetDate,
      tasks = [],
      shopping = [],
      milestones = [],
      today,
    } = body as {
      title?: string
      kind?: string
      targetDate?: string
      tasks?: { title: string; isCompleted?: boolean }[]
      shopping?: { name: string; isPurchased?: boolean }[]
      milestones?: { title: string; date?: string; isComplete?: boolean }[]
      today?: string
    }

    const fmtTasks =
      tasks.length > 0
        ? tasks
            .map((t) => `- [${t.isCompleted ? 'x' : ' '}] ${t.title}`)
            .join('\n')
        : '(none)'
    const fmtShopping =
      shopping.length > 0
        ? shopping
            .map((s) => `- [${s.isPurchased ? 'x' : ' '}] ${s.name}`)
            .join('\n')
        : '(none)'
    const fmtMilestones =
      milestones.length > 0
        ? milestones
            .map(
              (m) =>
                `- [${m.isComplete ? 'x' : ' '}] ${m.title}${m.date ? ` (${m.date})` : ''}`
            )
            .join('\n')
        : '(none)'

    const prompt = `You are an expert family planning assistant assessing readiness for an upcoming initiative.

PLAN: "${title}" (${kind})
Target date: ${targetDate || 'not set'}
Today: ${today || 'unknown'}

MILESTONES:
${fmtMilestones}

TASKS:
${fmtTasks}

SHOPPING:
${fmtShopping}

Assess how ready this plan is. Reason about what is done vs. not done, how much time remains until the target date, and what is most at risk of slipping. Be specific and practical.

Return ONLY valid JSON in exactly this shape:
{"readiness": <integer 0-100>, "readinessSummary": "<one or two sentences>", "risks": ["<short risk>", "..."], "insights": ["<short actionable insight>", "..."]}

readiness reflects overall preparedness given completion and time remaining. Provide 1-4 risks and 1-4 insights. If everything looks complete, risks may be an empty array.`

    const response = await anthropic.messages.create({
      model: MODEL_DEEP,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    const result = parseJSON<{
      readiness?: number
      readinessSummary?: string
      risks?: string[]
      insights?: string[]
    }>(text)

    const clamped = Math.max(
      0,
      Math.min(100, Math.round(result.readiness ?? 0))
    )

    return NextResponse.json({
      readiness: clamped,
      readinessSummary: result.readinessSummary ?? '',
      risks: result.risks ?? [],
      insights: result.insights ?? [],
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
