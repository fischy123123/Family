// ─────────────────────────────────────────────────────────────
// FamilyOS Type System
// ─────────────────────────────────────────────────────────────
// FamilyOS is a decision-support system for family life. These types
// model not just information, but ATTENTION — what needs to happen next.

// ============================================================
// FAMILY BRAIN — the knowledge system
// ============================================================

export interface RoutineEntry {
  id: string
  title: string            // "School pickup", "Soccer practice"
  schedule: string         // human-readable: "Weekdays 3:30pm", "Tue/Thu 5pm"
  notes?: string
}

export interface PreferenceEntry {
  id: string
  category: string         // "Food", "Activities", "Dislikes"
  text: string
}

export interface InfoEntry {
  id: string
  category: 'medical' | 'education' | 'logistics' | 'personal' | 'other'
  label: string            // "Allergies", "Teacher", "Shoe size"
  value: string
}

export interface MemoryEntry {
  id: string
  text: string
  createdAt: string
}

// ============================================================
// FAMILY BRAIN — household-level knowledge the assistant reasons through
// ============================================================

// The "lens": who this family is and what they care about. The assistant reads
// this before every briefing so it can prioritize what matters to THIS family.
export interface FamilyProfile {
  id: string                          // fixed doc id, e.g. "household"
  household?: string                  // free text: who we are, kids' ages, where we live, work
  priorities?: string[]               // what matters most ("never miss the kids' events")
  concerns?: string[]                 // stressors to watch ("money", "medical", "being late")
  communicationStyle?: 'brief' | 'balanced' | 'detailed'
  quietHours?: string                 // when not to surface non-urgent things
  updatedAt?: string
}

export type MemoryCategory =
  | 'fact' | 'preference' | 'routine' | 'health' | 'logistics' | 'relationship' | 'other'

// A single thing the assistant knows and should remember indefinitely. These
// accrete over time from onboarding, capture, copilot, and observed behavior.
export interface FamilyMemory {
  id: string
  text: string
  category?: MemoryCategory
  subjectEmail?: string               // legacy single subject (email or member id)
  subjectEmails?: string[]            // who this is about — emails or member ids; empty/absent = family-wide
  source?: 'manual' | 'ai' | 'capture' | 'onboarding'
  pinned?: boolean                    // always include in context, never auto-trim
  // Time-bound facts (e.g. "grounded until 6/28", "has a cold this week") carry
  // an expiry date (YYYY-MM-DD). Once past, they're filtered out before reaching
  // the model so stale facts stop polluting briefings — no manual forget needed.
  expiresAt?: string
  // ── Provenance links (factual, set at creation time — never inferred) ──
  relatedEventId?: string             // the calendar event this memory annotates
  relatedTaskId?: string              // the task this memory annotates
  createdAt: string
}

// The people a memory is about, combining the new multi-subject field with the
// legacy single field. Empty array means family-wide (concerns everyone / no
// single owner). Identifiers may be emails or member ids.
export function memorySubjects(m: FamilyMemory): string[] {
  const out = [...(m.subjectEmails ?? [])]
  if (m.subjectEmail && !out.some((s) => s.toLowerCase() === m.subjectEmail!.toLowerCase())) {
    out.unshift(m.subjectEmail)
  }
  return out
}

// True if a given member (by email and/or id) is among a memory's subjects.
export function memoryConcernsMember(
  m: FamilyMemory,
  memberEmail?: string,
  memberId?: string
): boolean {
  const subjects = memorySubjects(m).map((s) => s.toLowerCase())
  if (memberEmail && subjects.includes(memberEmail.toLowerCase())) return true
  if (memberId && subjects.includes(memberId.toLowerCase())) return true
  return false
}

export interface TimelineMilestone {
  id: string
  title: string
  date: string             // ISO date
  notes?: string
}

// ============================================================
// LIFE COACHING — proactive, values-aligned guidance
// ============================================================
// The attention engine answers "what needs to happen today." The coaching
// layer answers a different question: "are we becoming the family we want to
// be?" It reasons over longer time horizons, notices drift from stated values,
// and reflects rather than instructs.

// The areas of family life the coach watches for balance and neglect.
export type LifeArea =
  | 'health' | 'relationships' | 'kids' | 'finances'
  | 'home' | 'personal' | 'work-life' | 'fun'

// A standing commitment for how the family wants to operate. Unlike a Task
// (one-off) this is an ongoing intention the coach holds them accountable to,
// e.g. "family dinner at least 4 nights a week" or "monthly date night".
export interface FamilyGoal {
  id: string
  text: string                  // the commitment itself
  area: LifeArea
  cadence?: string              // free text: "weekly", "4x/week", "monthly"
  why?: string                  // why it matters — shapes the coaching tone
  active: boolean
  createdAt: string
}

// An observation the coaching engine surfaces. Softer than an AttentionItem —
// reflective, not transactional.
export type InsightType =
  | 'celebration'   // something going well, worth recognizing
  | 'drift'         // slipping from a stated goal/value
  | 'pattern'       // a trend noticed over time
  | 'suggestion'    // a low-pressure idea to try
  | 'question'      // a reflective question to sit with

export interface CoachingInsight {
  id: string
  type: InsightType
  area?: LifeArea
  title: string
  detail: string
  question?: string             // optional reflective question
  relatedGoalId?: string
  suggestedAction?: string      // optional concrete next step
  actionType?: 'copilot' | 'capture' | 'calendar' | 'goal'
  generatedAt: string
  weekOf?: string               // ISO date of the week this belongs to
  dismissed?: boolean
  acknowledged?: boolean
}

// A weekly reflection captured from a family member. Stored so the coach
// learns what's really happening beneath the logistics.
export interface Reflection {
  id: string
  weekOf: string                // ISO date of the week (Sunday) it covers
  wentWell?: string
  wasHard?: string
  wouldChange?: string
  gratitude?: string
  authorEmail?: string
  createdAt: string
}

export type GroceryCategory = 'produce' | 'dairy' | 'meat' | 'bakery' | 'pantry' | 'frozen' | 'household' | 'other'

export interface GroceryItem {
  id: string
  name: string
  category: GroceryCategory
  frequency: 'always' | 'sometimes'   // 'always' = pre-selected on weekly restock
  status: 'need' | 'stocked'
  notes?: string
  addedBy?: string
  lastBoughtAt?: string               // ISO string, set when checked off in shop mode
  createdAt: string
}

export interface FamilyMember {
  id: string
  name: string
  email: string
  colorHex: string
  emoji: string
  role: 'parent' | 'child' | 'pet' | 'other'
  // Family Brain extensions (all optional for backward-compat)
  birthday?: string
  summary?: string                    // AI/user one-liner about this person
  species?: string                    // for pets: e.g. "Golden Retriever"
  routines?: RoutineEntry[]
  preferences?: PreferenceEntry[]
  importantInfo?: InfoEntry[]
  memories?: MemoryEntry[]
  timeline?: TimelineMilestone[]
}

// ============================================================
// ATTENTION ENGINE — the core output
// ============================================================

export type AttentionBucket = 'now' | 'next' | 'later' | 'upcoming'

export interface AttentionItem {
  id: string
  bucket: AttentionBucket
  title: string                 // the instruction: "Leave for soccer pickup"
  reason: string                // why this matters now
  startBy?: string              // ISO time the user should begin acting
  dueAt?: string                // ISO time the underlying thing happens
  // Assignment is two-sided: who the thing is FOR/ABOUT (e.g. the kids), and
  // who is RESPONSIBLE for handling it (e.g. the parent doing pickup). They can
  // differ — a kid's appointment is "for" the kid but a parent handles it.
  assigneeEmail?: string        // the responsible person
  forEmails?: string[]          // who it concerns / is about (often kids)
  sourceType: 'event' | 'task' | 'chore' | 'plan' | 'reminder' | 'inferred'
  sourceId?: string
  sourceEmailId?: string        // Gmail message ID — present when item derives from an inbox email
  priority: number              // 0-100, higher = more urgent
  groupKey?: string             // set the same groupKey on items about the same topic; they'll be shown as one grouped card
}

export interface PotentialProblem {
  id: string
  title: string                 // "No dinner planned for tonight"
  detail: string                // explanation
  severity: 'low' | 'medium' | 'high'
  suggestedAction?: string
  actionType?: 'copilot' | 'capture' | 'calendar'
  relatedDate?: string
  sourceEmailId?: string        // Gmail message ID — present when problem derives from an inbox email
}

export interface Recommendation {
  id: string
  title: string                 // "Pack swim bags tonight"
  rationale: string             // why it reduces future stress
  actionLabel?: string          // "Add to tonight's list"
  // How the action button should behave. 'capture' (default) opens the Capture
  // sheet so the recommendation becomes a real task/event/list item in place;
  // 'copilot' hands off to a conversation only when genuine back-and-forth is
  // needed (e.g. "help me plan a date night").
  actionType?: 'copilot' | 'capture' | 'calendar'
  // Names of family members the recommended action is for/about (e.g. ["Maddie"]).
  // Used to auto-assign the task when the user taps the action button.
  forNames?: string[]
}

export interface EventAssignmentSuggestion {
  id?: string
  eventTitle: string   // exact title as it appears in UPCOMING EVENTS
  eventDate: string    // YYYY-MM-DD
  forNames: string[]   // exact member names the AI thinks this event is for
  confidence: 'high' | 'medium' | 'low'
  reason: string       // one-sentence explanation
}

export interface AttentionReport {
  generatedAt: string
  greeting: string              // contextual one-liner
  items: AttentionItem[]
  problems: PotentialProblem[]
  recommendations: Recommendation[]
  eventAssignments?: EventAssignmentSuggestion[]  // AI-inferred "who is this event for?" — pending confirmation
}

// ============================================================
// OPEN LOOPS / TASKS — unresolved responsibilities
// ============================================================

export interface Task {
  id: string
  title: string
  notes?: string
  isCompleted: boolean
  completedAt?: string
  dueDate?: string
  assigneeId?: string           // canonical assignment key (member id)
  assigneeEmail?: string        // legacy / AI-derived fallback
  forIds?: string[]             // who the task is FOR/ABOUT (e.g. a child's appt)
  priority: 'none' | 'low' | 'medium' | 'high'
  recurrence?: RecurrenceRule
  planId?: string               // if part of a Plan
  source?: 'manual' | 'capture' | 'ai' | 'email'
  // ── Provenance links (factual, set at creation time — never inferred) ──
  relatedEventId?: string       // the calendar event this task prepares for / is about
  sourceEmailId?: string        // Gmail message ID this task was created from
  createdAt: string
}

// ============================================================
// PLANS — multi-step initiatives / living workspaces
// ============================================================

export type PlanKind =
  | 'trip' | 'vacation' | 'school-year' | 'holiday'
  | 'birthday' | 'home-project' | 'event' | 'other'

export interface PlanTask {
  id: string
  title: string
  isCompleted: boolean
  dueDate?: string
  assigneeEmail?: string
}

export interface PlanShoppingItem {
  id: string
  name: string
  quantity?: number
  isPurchased: boolean
}

export interface PlanDocument {
  id: string
  label: string
  url?: string
  notes?: string
}

export interface PlanMilestone {
  id: string
  title: string
  date: string
  isComplete: boolean
}

export interface Plan {
  id: string
  title: string
  kind: PlanKind
  emoji: string
  colorHex: string
  summary?: string
  targetDate?: string             // when the plan culminates (trip start, party day)
  createdAt: string
  participants: string[]          // member emails
  milestones: PlanMilestone[]
  tasks: PlanTask[]
  shopping: PlanShoppingItem[]
  documents: PlanDocument[]
  // AI-generated, cached
  readiness?: number              // 0-100
  readinessSummary?: string
  risks?: string[]
  insights?: string[]
}

// ============================================================
// LISTS — intelligent, context-aware
// ============================================================

export type ListKind = 'grocery' | 'shopping' | 'packing' | 'tasks' | 'household' | 'custom'

export interface SmartListItem {
  id: string
  name: string
  quantity?: number
  unit?: string
  category?: string
  isComplete: boolean
  isRecurring?: boolean
  notes?: string
}

export interface SmartList {
  id: string
  name: string
  kind: ListKind
  emoji: string
  colorHex: string
  store?: string
  createdAt: string
  items: SmartListItem[]
  planId?: string
}

// ============================================================
// CAPTURE — everything in becomes structured action
// ============================================================

export type CaptureInputType = 'text' | 'voice' | 'image' | 'email' | 'document'
export type CaptureStatus = 'pending' | 'processed' | 'error'

export interface ExtractedOutcome {
  kind: 'task' | 'event' | 'shopping_item' | 'packing_item' | 'plan' | 'memory' | 'follow_up'
  title: string
  date?: string
  assignee?: string             // AI-emitted member name (resolves to id; works for emailless members)
  assigneeEmail?: string        // legacy
  notes?: string
  targetListId?: string
  targetPlanId?: string
  applied?: boolean
}

export interface Capture {
  id: string
  inputType: CaptureInputType
  rawText: string
  imageUrl?: string
  status: CaptureStatus
  createdAt: string
  outcomes: ExtractedOutcome[]
  summary?: string
}

// ============================================================
// COPILOT — conversational interface
// ============================================================

export interface CopilotMessage {
  role: 'user' | 'assistant'
  content: string
  actions?: string[]
}

// ============================================================
// LEGACY TYPES (kept for backward compatibility during migration)
// ============================================================

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  isAllDay: boolean
  location?: string
  notes?: string
  calendarId: string
  calendarName?: string
  ownerEmail: string
  color: string
  recurringEventId?: string
  forIds?: string[]      // who this event is for/about (multi-select)
  assigneeId?: string    // who is responsible for making it happen (single)
  // ── Provenance links (factual, set at creation time — never inferred) ──
  sourceEmailId?: string // Gmail message ID this event was created from
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
  assigneeId?: string           // canonical assignment key (member id)
  assigneeEmail?: string        // legacy / AI-derived fallback
  recurrence?: RecurrenceRule
  // ── Provenance link (factual, set at creation time — never inferred) ──
  relatedEventId?: string       // the calendar event this reminder prepares for / is about
}

export interface Chore {
  id: string
  name: string
  assigneeId?: string           // canonical assignment key (member id)
  assigneeEmail: string         // legacy / AI-derived fallback
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

// ============================================================
// CONSTANTS
// ============================================================

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

export const PLAN_KINDS: { kind: PlanKind; label: string; emoji: string }[] = [
  { kind: 'trip', label: 'Trip', emoji: '✈️' },
  { kind: 'vacation', label: 'Vacation', emoji: '🏖️' },
  { kind: 'school-year', label: 'School Year', emoji: '🎒' },
  { kind: 'holiday', label: 'Holiday', emoji: '🎄' },
  { kind: 'birthday', label: 'Birthday', emoji: '🎂' },
  { kind: 'home-project', label: 'Home Project', emoji: '🔨' },
  { kind: 'event', label: 'Event', emoji: '🎉' },
  { kind: 'other', label: 'Other', emoji: '📋' },
]

export const LIST_KINDS: { kind: ListKind; label: string; emoji: string }[] = [
  { kind: 'grocery', label: 'Grocery', emoji: '🛒' },
  { kind: 'shopping', label: 'Shopping', emoji: '🛍️' },
  { kind: 'packing', label: 'Packing', emoji: '🧳' },
  { kind: 'tasks', label: 'Tasks', emoji: '✅' },
  { kind: 'household', label: 'Household', emoji: '🏠' },
  { kind: 'custom', label: 'Custom', emoji: '📝' },
]

export const BUCKET_META: Record<AttentionBucket, { label: string; color: string }> = {
  now: { label: 'Now', color: '#EF4444' },
  next: { label: 'Next', color: '#F97316' },
  later: { label: 'Later Today', color: '#3B82F6' },
  upcoming: { label: 'Upcoming', color: '#8B5CF6' },
}

export const LIFE_AREAS: { area: LifeArea; label: string; emoji: string; color: string }[] = [
  { area: 'health',        label: 'Health',        emoji: '🌱', color: '#22C55E' },
  { area: 'relationships', label: 'Relationships', emoji: '❤️', color: '#EC4899' },
  { area: 'kids',          label: 'Kids',          emoji: '🧒', color: '#F59E0B' },
  { area: 'finances',      label: 'Finances',      emoji: '💰', color: '#14B8A6' },
  { area: 'home',          label: 'Home',          emoji: '🏠', color: '#8B5CF6' },
  { area: 'personal',      label: 'Personal',      emoji: '🧘', color: '#6366F1' },
  { area: 'work-life',     label: 'Work–Life',     emoji: '⚖️', color: '#3B82F6' },
  { area: 'fun',           label: 'Fun',           emoji: '🎉', color: '#EF4444' },
]

export const INSIGHT_META: Record<InsightType, { label: string; color: string; emoji: string }> = {
  celebration: { label: 'Going well', color: '#22C55E', emoji: '✨' },
  drift:       { label: 'Drifting',   color: '#F59E0B', emoji: '🧭' },
  pattern:     { label: 'Pattern',    color: '#3B82F6', emoji: '🔍' },
  suggestion:  { label: 'Try this',   color: '#8B5CF6', emoji: '💡' },
  question:    { label: 'Reflect',    color: '#64748B', emoji: '🤔' },
}
