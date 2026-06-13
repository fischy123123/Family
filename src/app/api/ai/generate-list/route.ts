import { NextRequest, NextResponse } from 'next/server'
import { askClaudeJSON } from '@/lib/ai'

export async function POST(request: NextRequest) {
  try {
    const { goal, kind = 'checklist' } = await request.json()
    if (!goal || typeof goal !== 'string') {
      return NextResponse.json({ error: 'No goal provided' }, { status: 400 })
    }

    const prompt = kind === 'shopping'
      ? `You are a helpful shopping assistant. The user wants a shopping list for: "${goal}".
Generate a practical list of items to buy. Return ONLY a JSON array of objects:
[{"name":"item name","quantity":1,"category":"one of [Produce, Dairy, Meat & Seafood, Bakery, Frozen, Pantry, Beverages, Household, Personal Care, Other]"}]
Keep it focused and realistic (10-20 items). Return only the JSON.`
      : `You are a helpful planning assistant. The user wants a checklist for: "${goal}".
Generate a practical, well-ordered list of checklist item titles. Return ONLY a JSON array of strings:
["First task","Second task","..."]
Keep it focused and realistic (8-20 items). Return only the JSON.`

    const items = await askClaudeJSON<unknown[]>(prompt)
    return NextResponse.json({ items })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
