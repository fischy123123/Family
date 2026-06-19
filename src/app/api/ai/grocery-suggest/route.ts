import { NextRequest, NextResponse } from 'next/server'
import { getAnthropic, MODEL_FAST, logUsage } from '@/lib/ai'
import type { GroceryItem } from '@/lib/types'

interface SuggestResult {
  suggestedIds: string[]
}

export async function POST(request: NextRequest) {
  try {
    const { items } = await request.json() as { items: GroceryItem[] }

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ suggestedIds: [] })
    }

    const anthropic = getAnthropic()
    const now = new Date()

    // Pre-filter: only stocked items are candidates for restocking
    const stockedItems = items.filter((item) => item.status === 'stocked')

    if (stockedItems.length === 0) {
      return NextResponse.json({ suggestedIds: [] })
    }

    const itemList = stockedItems.map((item) => {
      const daysSinceLastBought = item.lastBoughtAt
        ? Math.floor((now.getTime() - new Date(item.lastBoughtAt).getTime()) / (1000 * 60 * 60 * 24))
        : null
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        frequency: item.frequency,
        daysSinceLastBought,
      }
    })

    const prompt = `Today's date: ${now.toISOString().split('T')[0]}

Here are the family's stocked grocery items:
${JSON.stringify(itemList, null, 2)}

Based on the rules:
- 'always' frequency items not bought in 6+ days should be restocked
- 'always' frequency items with null daysSinceLastBought should be restocked
- 'sometimes' frequency items not bought in 14+ days should be restocked

Return only the JSON: { "suggestedIds": ["id1", "id2"] }`

    const response = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 500,
      system: 'You are a grocery assistant. Given a family\'s grocery item list, identify which stocked items should probably be restocked this week. An item should be restocked if: it\'s marked \'always\' frequency and hasn\'t been bought in 6+ days, or it\'s marked \'sometimes\' and hasn\'t been bought in 14+ days. Return only the JSON: { suggestedIds: [\'id1\', \'id2\'] }',
      messages: [{ role: 'user', content: prompt }],
    })
    logUsage('grocery-suggest', MODEL_FAST, response.usage)

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      return NextResponse.json({ suggestedIds: [] })
    }

    const result = JSON.parse(match[0]) as SuggestResult
    return NextResponse.json({ suggestedIds: result.suggestedIds ?? [] })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
