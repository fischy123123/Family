export interface FamilyMember {
  id: string
  name: string
  email: string
  colorHex: string
  emoji: string
  role: 'parent' | 'child' | 'other'
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  isAllDay: boolean
  location?: string
  notes?: string
  calendarId: string
  ownerEmail: string
  color: string
}

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval: number
  daysOfWeek?: number[]
}

export interface FamilyReminder {
  id: string
  title: string
  dueDate?: string
  isCompleted: boolean
  completedAt?: string
  priority: 'none' | 'low' | 'medium' | 'high'
  notes?: string
  assigneeEmail?: string
  recurrence?: RecurrenceRule
}

export interface Chore {
  id: string
  name: string
  assigneeEmail: string
  colorHex: string
  recurrence: RecurrenceRule
  lastCompletedDate?: string
  streak: number
}

export interface ChecklistItem {
  id: string
  title: string
  isCompleted: boolean
  notes?: string
}

export interface Checklist {
  id: string
  name: string
  colorHex: string
  createdAt: string
  items: ChecklistItem[]
}

export interface ShoppingItem {
  id: string
  name: string
  quantity: number
  unit: string
  category: string
  isPurchased: boolean
}

export interface ShoppingList {
  id: string
  name: string
  store?: string
  colorHex: string
  items: ShoppingItem[]
}

export interface MealPlan {
  id: string
  date: string
  mealName: string
  ingredients: string[]
  notes?: string
}

export interface Template {
  id: string
  name: string
  kind: 'checklist' | 'shopping'
  colorHex: string
  items: string[]
}

export interface AISuggestion {
  type: 'event' | 'reminder' | 'chore'
  title: string
  date?: string
  notes?: string
  confidence: number
  sourceEmailSubject: string
}

export interface EmailSnippet {
  subject: string
  snippet: string
  date: string
}

export interface PushSubscription {
  userEmail: string
  subscription: string
}

export const SHOPPING_CATEGORIES = [
  'Produce',
  'Dairy',
  'Meat & Seafood',
  'Bakery',
  'Frozen',
  'Pantry',
  'Beverages',
  'Household',
  'Personal Care',
  'Other',
] as const

export const MEMBER_COLORS = [
  '#EF4444', // red
  '#F97316', // orange
  '#EAB308', // yellow
  '#22C55E', // green
  '#3B82F6', // blue
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#14B8A6', // teal
  '#F59E0B', // amber
  '#6366F1', // indigo
]

export const CHORE_COLORS = MEMBER_COLORS

export const PRIORITY_COLORS: Record<FamilyReminder['priority'], string> = {
  none: '#6B7280',
  low: '#22C55E',
  medium: '#F97316',
  high: '#EF4444',
}
