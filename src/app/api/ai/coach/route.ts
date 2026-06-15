import { NextRequest, NextResponse } from 'next/server'
import { generateCoaching, type CoachInput } from '@/lib/coach'

// On-demand life-coaching run. The client sends full family context plus the
// coaching-specific material (goals, reflections, history) and gets back a
// reflective summary and a small set of insights.
export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  try {
    const input = (await request.json()) as CoachInput
    const result = await generateCoaching(input)

    const now = new Date().toISOString()
    // Anchor to the start of the current week (Sunday) so insights group cleanly.
    const d = new Date(now)
    d.setDate(d.getDate() - d.getDay())
    d.setHours(0, 0, 0, 0)
    const weekOf = d.toISOString()

    const insights = result.insights.map((it, i) => ({
      id: `coach-${Date.now()}-${i}`,
      generatedAt: now,
      weekOf,
      ...it,
    }))

    return NextResponse.json({ summary: result.summary, insights, generatedAt: now })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Coaching engine failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
