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
  category: 'medical' | 'education' | 'logistics' | 'personal' | 'work' | 'other'
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
  briefingRules?: string[]            // hard behavioral rules injected as authoritative instructions — e.g. "never group swim lessons under Family; each child gets their own card"
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
  // Set when the user re-confirms an aging fact is still true (via the
  // interview/refresh flow). Context freshness reads confirmedAt ?? createdAt,
  // so a confirmation makes the fact read as fresh everywhere at once.
  confirmedAt?: string
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

// ============================================================
// MOMENT COACH — in-the-moment, ADHD-aware personal guidance
// ============================================================
// The attention engine answers "what's on the family's plate." The coaching
// layer answers "are we becoming who we want to be." The Moment Coach answers a
// THIRD, more immediate question, for the signed-in person alone: "given how I
// feel right this second, what is the single best thing for me to do NOW — and
// how do I start it?" It's built for executive-function support: one move, a
// trivially small first step, a gentler fallback, and a warm, non-shaming voice.

// The signed-in user's personal "about me" model — distinct from the household
// FamilyProfile. Powers the Moment Coach so its guidance is tuned to this
// specific person: what they're working toward, what trips them up, and what
// actually helps them start. A few fields are captured up front; the rest
// accrete over time from use and feedback. One document per person.
export interface PersonalProfile {
  id: string                    // sanitized signed-in email — one per person
  email: string
  // Captured up front (the few essentials):
  goals?: string[]              // what they're working toward / want more of
  biggestStruggle?: string      // the thing that most gets in their way
  // Refined over time (all optional):
  energizers?: string[]         // activities/states that give them energy
  drainers?: string[]           // what depletes them
  startStrategies?: string[]    // tactics that actually help THEM begin a task
  avoiding?: string[]           // things they keep meaning to do but put off
  freeform?: string             // anything else they want the coach to know
  hasAdhd?: boolean             // tunes the coach toward initiation support

  // ── Your days (rhythm) — how the day actually flows, beyond the calendar ──
  rhythm?: string               // when they focus best vs. crash (e.g. "sharp 6-9am, fried after lunch")
  fixedAnchors?: string[]       // recurring NON-calendar anchors: pickup/drop-off, work hours, bedtime, meds

  // ── Household dynamic — who does what, and who's around ──
  householdRoles?: string       // division of labor by default ("I do mornings + pickup; partner does dinner + bedtime")
  careSchedule?: string         // which days they have the kids / partner availability/travel pattern

  // ── How they want the plan built ──
  planStyle?: 'minimal' | 'balanced' | 'packed'  // how full a day should feel
  planStructure?: DayPlanStructure  // default prescriptiveness: flexible vs. time-blocked
  protectRest?: boolean         // explicitly carve out rest/downtime
  nonNegotiables?: string[]     // hard rules the plan must respect ("nothing after 8pm bedtime")

  updatedAt?: string
}

// The 2-tap check-in that tailors guidance to the user's current state.
export type MomentEnergy = 'wired' | 'okay' | 'drained'
export type MomentMood = 'good' | 'meh' | 'low' | 'anxious'

// One concrete in-the-moment recommendation.
export interface MomentMove {
  title: string                 // the one thing to do now (short, concrete)
  why: string                   // why this, why now — ties to their goals/state
  firstStep: string             // a trivially small way to begin (lowers activation energy)
  minutes?: number              // rough size, so it feels bounded not infinite
  kind?: 'family' | 'personal' | 'rest' | 'admin' | 'connection'
}

// The Moment Coach's response: meet-them-where-they-are opener, the single best
// move, an easier fallback, and an optional tie to the bigger picture.
export interface MomentGuidance {
  pep: string                   // warm, validating opener — names how they feel
  primary: MomentMove           // the single best move right now
  fallback?: MomentMove         // "if that feels like too much, do this instead"
  bigPicture?: string           // optional one-liner connecting now to what matters
  generatedAt: string
  energy?: MomentEnergy
  mood?: MomentMood
}

// A logged check-in — every time the user tells the coach how they feel and
// what's going on, we persist it. This becomes trending data: the coach reads
// recent entries to notice patterns ("drained every evening," "overwhelmed at
// pickup three days running") and treat them as durable context, not just a
// one-off. One document per check-in, in the signed-in person's own log.
export interface MomentCheckIn {
  id: string
  email: string                 // whose check-in (the signed-in person)
  ts: string                    // ISO timestamp of the check-in
  energy: MomentEnergy
  mood?: MomentMood
  situation?: string            // free-text / transcribed "what's going on right now"
  primaryTitle?: string         // the move the coach suggested (for follow-through tracking)
  outcome?: 'did_it' | 'dismissed'  // set later if they act on or move past it
}

// ============================================================
// DAY PLAN — an interactive, tracked plan for today
// ============================================================
// Where the Moment Coach answers "what now," the Day Plan is the backbone for
// the whole day: built WITH the user (AI drafts → they tap + chat to adjust →
// finalize), then tracked to completion. Hybrid by design — fixed calendar
// commitments are time-anchored, everything else is a flexible, ordered pool of
// "moves" so a derailed day doesn't break the plan.

export type DayPlanStatus = 'draft' | 'active' | 'done'

// How prescriptive the plan is. 'flexible' = anchors + an ordered pool of moves
// with no rigid clock times (forgiving, the default). 'structured' = a strict,
// time-blocked schedule: every item has a specific time and moves are broken
// into concrete ordered steps — for when you want to be told exactly what to do.
export type DayPlanStructure = 'flexible' | 'structured'

// 'anchor' = a fixed, time-bound commitment (usually a calendar event) the day
// is built around. 'move' = a flexible intention with no rigid clock time,
// pulled from the pool when there's room.
export type DayPlanItemKind = 'anchor' | 'move'

export interface DayPlanItem {
  id: string
  title: string
  why?: string                  // one line — why it earned a place today
  kind: DayPlanItemKind
  startTime?: string            // ISO — set for anchors (and optionally scheduled moves)
  minutes?: number              // rough size, not a hard slot
  category?: MomentMove['kind'] // family | personal | rest | admin | connection
  firstStep?: string            // a trivially small way to begin (ADHD initiation)
  steps?: string[]              // concrete ordered sub-steps — used in 'structured' plans
  // Provenance — link back to the real entity so checking it off can sync.
  sourceType?: 'event' | 'task' | 'reminder' | 'inferred'
  sourceId?: string
  done: boolean
  doneAt?: string
}

export interface DayPlan {
  id: string                    // `${emailKey}_${date}` — one plan per person per day
  email: string
  date: string                  // YYYY-MM-DD (the user's local day)
  status: DayPlanStatus
  structure?: DayPlanStructure  // flexible (default) vs. structured/time-blocked
  intention?: string            // the kickoff "what's on your mind today"
  energy?: MomentEnergy
  headline?: string             // the coach's one-line framing of the day
  items: DayPlanItem[]          // anchors + moves, in intended order
  createdAt: string
  finalizedAt?: string          // when the user locked it in (draft → active)
  updatedAt?: string
}

// ============================================================
// GOAL SCORECARD — how you're performing against each commitment
// ============================================================
// Grades each standing goal/commitment against what you actually planned and
// completed (and missed) over recent days, with a score and a short story.

export type GoalGrade = 'on_track' | 'building' | 'slipping' | 'stalled'

export interface GoalScoreCard {
  goalId: string
  status: GoalGrade
  score: number          // 0-100
  headline: string       // a few words
  story: string          // 2-3 honest sentences citing real evidence + a nudge
}

export interface GoalScorecard {
  overall: string        // 1-2 sentence summary across all goals
  cards: GoalScoreCard[]
  generatedAt: string
}

export const GOAL_GRADE_META: Record<GoalGrade, { label: string; color: string; emoji: string }> = {
  on_track: { label: 'On track', color: '#22C55E', emoji: '🟢' },
  building:  { label: 'Building', color: '#3B82F6', emoji: '🔵' },
  slipping:  { label: 'Slipping', color: '#F59E0B', emoji: '🟠' },
  stalled:   { label: 'Stalled',  color: '#EF4444', emoji: '🔴' },
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
  groupKey?: string             // internal join key — same value on items about one topic; they collapse into one card
  groupTitle?: string           // human-readable header shown for the grouped card (e.g. "Maddie's therapy")
  section?: string              // person's first name exactly, or "Family" for shared items
  detail?: string               // optional 1-2 sentence expanded context, shown on tap
  nextMove?: string             // radar items: the concrete first action to move this forward
  kind?: 'action' | 'awareness' // action = something to do/decide; awareness = logistics/info
  plate?: 'self' | 'others'     // which ownership tier produced it — tagged client-side from the scoped call that returned it
}

// ── CONNECTIONS — the connect-the-dots engine ────────────────────────────────
// A Connection is an insight that only exists because two or more INDEPENDENT
// sources were read together (an email + a goal, a calendar gap + a memory, a
// trigger + a season). It carries the dots it joined so the reasoning is
// inspectable — that is what makes it trustworthy rather than a "sprinkle" —
// and 1-3 concrete moves so acting on it costs almost no executive function.
export interface ConnectionMove {
  label: string                 // the action, imperative and specific ("Text Sarah's mom about Thursday carpool")
  detail?: string               // optional one-line how/why
  kind?: 'plan' | 'task'        // where it should land by default
  when?: string                 // 'today' | 'this-week' | ISO date
  minutes?: number              // rough effort, so tiny wins are obvious
}

export interface Connection {
  id: string
  title: string                 // names the insight, ≤ 10 words
  insight: string               // the synthesis — what joining these reveals (2-3 sentences)
  dots: string[]                // the specific sources joined, each ≤ 10 words, prefixed by kind
  why?: string                  // ties it to a stated goal or value
  moves: ConnectionMove[]       // 1-3 concrete next actions
  priority?: number             // 0-100
  horizon?: 'today' | 'this-week' | 'this-month'
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

export interface AttentionReport {
  generatedAt: string
  greeting: string              // contextual one-liner
  items: AttentionItem[]
  problems: PotentialProblem[]
  recommendations: Recommendation[]
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
  kind: 'task' | 'event' | 'shopping_item' | 'packing_item' | 'plan' | 'memory' | 'follow_up' | 'trigger'
  title: string
  date?: string
  assignee?: string             // AI-emitted member name (resolves to id; works for emailless members)
  assigneeEmail?: string        // legacy
  notes?: string
  condition?: string            // trigger only — the "when Y" this intention waits for
  targetListId?: string
  targetPlanId?: string
  applied?: boolean
}

// A prospective-memory trigger: "when Y happens, do X". Not a task (no date)
// and not a memory (it's a dormant intention). It sleeps until the radar spots
// its condition going live in the calendar/context, then resurfaces with the
// action attached. This is the app remembering FOR a working memory that won't.
export interface ProspectiveTrigger {
  id: string
  condition: string             // plain language: "next time we visit Grandma", "when school break starts"
  action: string                // what to do when it fires: "bring the casserole dish back"
  subjectNames?: string[]       // who it involves, if anyone specific
  createdBy?: string            // email of whoever set it
  status: 'armed' | 'done' | 'dismissed'
  createdAt: string
  resolvedAt?: string
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

export const MOMENT_ENERGY_META: Record<MomentEnergy, { label: string; emoji: string; color: string }> = {
  wired:   { label: 'Wired',   emoji: '⚡️', color: '#F59E0B' },
  okay:    { label: 'Okay',    emoji: '🙂', color: '#22C55E' },
  drained: { label: 'Drained', emoji: '🥱', color: '#6366F1' },
}

export const MOMENT_MOOD_META: Record<MomentMood, { label: string; emoji: string; color: string }> = {
  good:    { label: 'Good',    emoji: '😊', color: '#22C55E' },
  meh:     { label: 'Meh',     emoji: '😐', color: '#94A3B8' },
  low:     { label: 'Low',     emoji: '😔', color: '#6366F1' },
  anxious: { label: 'Anxious', emoji: '😰', color: '#EF4444' },
}

export const MOMENT_KIND_META: Record<NonNullable<MomentMove['kind']>, { label: string; emoji: string; color: string }> = {
  family:     { label: 'Family',     emoji: '👨‍👩‍👧', color: '#F59E0B' },
  personal:   { label: 'You',        emoji: '🧘', color: '#6366F1' },
  rest:       { label: 'Rest',       emoji: '☕️', color: '#14B8A6' },
  admin:      { label: 'Admin',      emoji: '🗂️', color: '#3B82F6' },
  connection: { label: 'Connection', emoji: '❤️', color: '#EC4899' },
}

export const INSIGHT_META: Record<InsightType, { label: string; color: string; emoji: string }> = {
  celebration: { label: 'Going well', color: '#22C55E', emoji: '✨' },
  drift:       { label: 'Drifting',   color: '#F59E0B', emoji: '🧭' },
  pattern:     { label: 'Pattern',    color: '#3B82F6', emoji: '🔍' },
  suggestion:  { label: 'Try this',   color: '#8B5CF6', emoji: '💡' },
  question:    { label: 'Reflect',    color: '#64748B', emoji: '🤔' },
}
