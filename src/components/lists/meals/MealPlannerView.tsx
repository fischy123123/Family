'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Sparkles, ShoppingCart } from 'lucide-react'
import { format, startOfWeek, addDays, addWeeks, subWeeks } from 'date-fns'
import { useSheetsData } from '@/hooks/useSheetsData'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { MealPlan, ShoppingList, ShoppingItem } from '@/lib/types'
import { generateId } from '@/lib/utils'

export function MealPlannerView() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [editingDay, setEditingDay] = useState<Date | null>(null)
  const [editingMeal, setEditingMeal] = useState<MealPlan | null>(null)
  const [mealName, setMealName] = useState('')
  const [ingredients, setIngredients] = useState('')
  const [notes, setNotes] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const { data: meals, create, update, remove } = useSheetsData<MealPlan>('meal_plans')
  const { create: createShoppingList } = useSheetsData<ShoppingList>('shopping_lists')

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  function getMealForDay(date: Date): MealPlan | undefined {
    const dateStr = format(date, 'yyyy-MM-dd')
    return meals.find((m) => m.date === dateStr)
  }

  function openEdit(date: Date) {
    const meal = getMealForDay(date)
    setEditingDay(date)
    setEditingMeal(meal ?? null)
    setMealName(meal?.mealName ?? '')
    setIngredients(meal?.ingredients.join('\n') ?? '')
    setNotes(meal?.notes ?? '')
  }

  async function saveMeal() {
    if (!editingDay || !mealName.trim()) return
    setSaving(true)
    const dateStr = format(editingDay, 'yyyy-MM-dd')
    const ingredientList = ingredients.split('\n').map((s) => s.trim()).filter(Boolean)
    const meal: MealPlan = {
      id: editingMeal?.id ?? generateId(),
      date: dateStr,
      mealName: mealName.trim(),
      ingredients: ingredientList,
      notes: notes.trim() || undefined,
    }
    try {
      if (editingMeal) await update(meal)
      else await create(meal)
      setEditingDay(null)
    } finally {
      setSaving(false)
    }
  }

  async function deleteMeal() {
    if (editingMeal) await remove(editingMeal.id)
    setEditingDay(null)
  }

  async function suggestMeals() {
    setAiLoading(true)
    try {
      const res = await fetch('/api/gmail-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'meals' }),
      })
      const { meals: suggestions } = await res.json()
      if (Array.isArray(suggestions)) {
        for (let i = 0; i < Math.min(suggestions.length, 7); i++) {
          const day = days[i]
          const existing = getMealForDay(day)
          if (!existing && suggestions[i]) {
            await create({ id: generateId(), date: format(day, 'yyyy-MM-dd'), mealName: suggestions[i], ingredients: [] })
          }
        }
      }
    } finally {
      setAiLoading(false)
    }
  }

  async function addAllToShoppingList() {
    const allIngredients = days.flatMap((d) => getMealForDay(d)?.ingredients ?? [])
    const unique = Array.from(new Set(allIngredients))
    if (unique.length === 0) return

    const items: ShoppingItem[] = unique.map((name) => ({
      id: generateId(), name, quantity: 1, unit: '', category: 'Other', isPurchased: false,
    }))

    await createShoppingList({
      id: generateId(),
      name: `Week of ${format(weekStart, 'MMM d')}`,
      colorHex: '#22C55E',
      items,
    })
  }

  const weekMeals = days.map(getMealForDay).filter(Boolean)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Week navigation */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">Meal Planner</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekStart((w) => subWeeks(w, 1))} className="p-1 rounded-lg hover:bg-gray-100">
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-gray-600 font-medium">
            {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d')}
          </span>
          <button onClick={() => setWeekStart((w) => addWeeks(w, 1))} className="p-1 rounded-lg hover:bg-gray-100">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mb-4">
        <Button size="sm" variant="secondary" onClick={suggestMeals} disabled={aiLoading}>
          <Sparkles size={14} className="mr-1 text-purple-500" />
          {aiLoading ? 'Suggesting...' : 'AI Suggest'}
        </Button>
        {weekMeals.length > 0 && (
          <Button size="sm" variant="secondary" onClick={addAllToShoppingList}>
            <ShoppingCart size={14} className="mr-1" />
            Add All to Shopping
          </Button>
        )}
      </div>

      {/* Days grid */}
      <div className="space-y-2">
        {days.map((day) => {
          const meal = getMealForDay(day)
          const isToday = format(day, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')
          return (
            <div
              key={day.toISOString()}
              onClick={() => openEdit(day)}
              className={`flex items-center gap-3 p-3 bg-white rounded-xl border shadow-sm cursor-pointer hover:border-blue-200 transition-colors ${
                isToday ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-100'
              }`}
            >
              <div className="w-12 shrink-0 text-center">
                <p className="text-xs text-gray-400">{format(day, 'EEE')}</p>
                <p className={`text-lg font-bold ${isToday ? 'text-blue-600' : 'text-gray-800'}`}>{format(day, 'd')}</p>
              </div>
              <div className="flex-1 min-w-0">
                {meal ? (
                  <>
                    <p className="text-sm font-medium text-gray-900">{meal.mealName}</p>
                    {meal.ingredients.length > 0 && (
                      <p className="text-xs text-gray-400 truncate">{meal.ingredients.slice(0, 4).join(', ')}</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-300">Tap to plan dinner</p>
                )}
              </div>
              <Plus size={16} className="text-gray-300 shrink-0" />
            </div>
          )
        })}
      </div>

      {/* Edit modal */}
      <Dialog
        open={!!editingDay}
        onClose={() => setEditingDay(null)}
        title={editingDay ? `${format(editingDay, 'EEEE, MMM d')}` : ''}
      >
        <div className="space-y-3">
          <Input placeholder="Dinner name" value={mealName} onChange={(e) => setMealName(e.target.value)} autoFocus />
          <Textarea
            placeholder="Ingredients (one per line)"
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            rows={5}
          />
          <Input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2 pt-2">
            {editingMeal && (
              <Button type="button" variant="destructive" size="sm" onClick={deleteMeal}>Delete</Button>
            )}
            <div className="flex-1" />
            <Button type="button" variant="ghost" onClick={() => setEditingDay(null)}>Cancel</Button>
            <Button onClick={saveMeal} disabled={saving || !mealName.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
