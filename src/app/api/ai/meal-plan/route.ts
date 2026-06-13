import { NextRequest, NextResponse } from 'next/server'
import { askClaudeJSON } from '@/lib/ai'

interface MealOut {
  day: number // 0-6, Monday=0
  mealName: string
  ingredients: string[]
}

export async function POST(request: NextRequest) {
  try {
    const { preferences = '', filledDays = [] } = await request.json()

    const prompt = `You are a family meal-planning assistant. Plan dinners for a 7-day week (Monday=day 0 through Sunday=day 6).

${preferences ? `Family preferences/constraints: ${preferences}` : 'No specific preferences given — plan varied, family-friendly, balanced dinners.'}
${Array.isArray(filledDays) && filledDays.length > 0 ? `These day numbers already have meals, do NOT plan for them: ${filledDays.join(', ')}` : ''}

For each remaining day, choose a realistic home-cooked dinner with a concise ingredient list (5-10 items, just names like "chicken breast", "broccoli", not quantities).

Return ONLY a JSON array of objects: [{"day":0,"mealName":"...","ingredients":["...","..."]}]
Vary the cuisines and proteins across the week. Return only the JSON.`

    const meals = await askClaudeJSON<MealOut[]>(prompt)
    return NextResponse.json({ meals })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
