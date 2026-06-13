import { addDays, addWeeks, addMonths, isSameDay, startOfDay } from 'date-fns'
import type { RecurrenceRule, FamilyReminder, Chore } from './types'

export function nextOccurrence(rule: RecurrenceRule, from: Date = new Date()): Date {
  const base = startOfDay(from)

  if (rule.frequency === 'daily') {
    return addDays(base, rule.interval)
  }

  if (rule.frequency === 'weekly') {
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      // Find the next matching day of week
      for (let i = 1; i <= 7 * rule.interval; i++) {
        const candidate = addDays(base, i)
        if (rule.daysOfWeek.includes(candidate.getDay())) {
          return candidate
        }
      }
    }
    return addWeeks(base, rule.interval)
  }

  if (rule.frequency === 'monthly') {
    return addMonths(base, rule.interval)
  }

  return addDays(base, 1)
}

export function isDueToday(rule: RecurrenceRule, lastCompletedDate?: string): boolean {
  const today = startOfDay(new Date())

  if (!lastCompletedDate) {
    return true
  }

  const last = startOfDay(new Date(lastCompletedDate))

  if (rule.frequency === 'daily') {
    const next = addDays(last, rule.interval)
    return isSameDay(next, today) || next < today
  }

  if (rule.frequency === 'weekly') {
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      return rule.daysOfWeek.includes(today.getDay())
    }
    const next = addWeeks(last, rule.interval)
    return isSameDay(next, today) || next < today
  }

  if (rule.frequency === 'monthly') {
    const next = addMonths(last, rule.interval)
    return isSameDay(next, today) || next < today
  }

  return false
}

export function getReminderDueDate(reminder: FamilyReminder): Date | undefined {
  if (!reminder.recurrence) {
    return reminder.dueDate ? new Date(reminder.dueDate) : undefined
  }

  const lastCompleted = reminder.completedAt
    ? new Date(reminder.completedAt)
    : reminder.dueDate
    ? new Date(reminder.dueDate)
    : new Date()

  return nextOccurrence(reminder.recurrence, lastCompleted)
}

export function isChoreDueToday(chore: Chore): boolean {
  return isDueToday(chore.recurrence, chore.lastCompletedDate)
}

export function recurrenceLabel(rule: RecurrenceRule): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  if (rule.frequency === 'daily') {
    return rule.interval === 1 ? 'Daily' : `Every ${rule.interval} days`
  }

  if (rule.frequency === 'weekly') {
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      const names = rule.daysOfWeek.sort().map((d) => days[d])
      const prefix = rule.interval === 1 ? 'Weekly' : `Every ${rule.interval} weeks`
      return `${prefix} on ${names.join(', ')}`
    }
    return rule.interval === 1 ? 'Weekly' : `Every ${rule.interval} weeks`
  }

  if (rule.frequency === 'monthly') {
    return rule.interval === 1 ? 'Monthly' : `Every ${rule.interval} months`
  }

  return 'Recurring'
}

export function getUpcomingOccurrences(rule: RecurrenceRule, days: number): Date[] {
  const occurrences: Date[] = []
  let current = startOfDay(new Date())
  const end = addDays(current, days)

  while (current <= end) {
    if (isDueToday(rule, current.toISOString())) {
      occurrences.push(new Date(current))
    }
    current = addDays(current, 1)
  }

  return occurrences
}
