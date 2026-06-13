'use client'

import { Sparkles, Plus, Trash2, Calendar, Bell, Dumbbell } from 'lucide-react'
import { useGmailSuggestions } from '@/hooks/useGmailSuggestions'
import { useSheetsData } from '@/hooks/useSheetsData'
import { useCalendarEvents } from '@/hooks/useCalendarEvents'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { FamilyReminder, Chore } from '@/lib/types'
import { generateId } from '@/lib/utils'

const typeIcons = {
  event: Calendar,
  reminder: Bell,
  chore: Dumbbell,
}

export function SuggestionsPanel() {
  const { suggestions, isLoading, fetchSuggestions, dismiss } = useGmailSuggestions()
  const { create: createReminder } = useSheetsData<FamilyReminder>('reminders')
  const { create: createChore } = useSheetsData<Chore>('chores')
  const { create: createEvent } = useCalendarEvents()

  async function addSuggestion(index: number) {
    const s = suggestions[index]
    if (s.type === 'reminder') {
      await createReminder({
        id: generateId(),
        title: s.title,
        dueDate: s.date,
        isCompleted: false,
        priority: 'medium',
        notes: s.notes ?? '',
      })
    } else if (s.type === 'event' && s.date) {
      await createEvent({
        title: s.title,
        start: `${s.date}T09:00:00`,
        end: `${s.date}T10:00:00`,
        isAllDay: false,
        notes: s.notes ?? '',
        calendarId: 'primary',
      })
    } else if (s.type === 'chore') {
      await createChore({
        id: generateId(),
        name: s.title,
        assigneeEmail: '',
        colorHex: '#3B82F6',
        recurrence: { frequency: 'weekly', interval: 1 },
        streak: 0,
      })
    }
    dismiss(index)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-purple-500" />
            AI Suggestions
          </CardTitle>
          <Button
            size="sm"
            variant="secondary"
            onClick={fetchSuggestions}
            disabled={isLoading}
          >
            {isLoading ? 'Checking...' : 'Check Gmail'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {suggestions.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            {isLoading ? 'Analyzing your emails...' : 'Click "Check Gmail" to get AI suggestions from your inbox.'}
          </p>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s, i) => {
              const Icon = typeIcons[s.type] ?? Bell
              return (
                <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-purple-50 border border-purple-100">
                  <Icon size={16} className="text-purple-600 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{s.title}</p>
                    {s.date && <p className="text-xs text-gray-500">{s.date}</p>}
                    <p className="text-xs text-gray-400 truncate">From: {s.sourceEmailSubject}</p>
                    <div className="mt-1">
                      <Badge variant="secondary" className="text-xs">
                        {Math.round(s.confidence * 100)}% confident
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" onClick={() => addSuggestion(i)} className="h-7 w-7">
                      <Plus size={14} />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => dismiss(i)} className="h-7 w-7 text-gray-400">
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
