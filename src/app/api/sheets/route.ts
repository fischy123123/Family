import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { readSheet, upsertRow, deleteRow, findRowById, appendRow } from '@/lib/google/sheets'
import type { SheetTab } from '@/lib/google/sheets'
import {
  Checklist,
  ShoppingList,
  FamilyReminder,
  Chore,
  MealPlan,
  Template,
  FamilyMember,
} from '@/lib/types'
import { generateId } from '@/lib/utils'

// Serializers: object → string[] row
function serializeMember(m: FamilyMember): string[] {
  return [m.id, m.name, m.email, m.colorHex, m.emoji, m.role]
}
function deserializeMember(row: string[]): FamilyMember {
  return { id: row[0], name: row[1], email: row[2], colorHex: row[3], emoji: row[4], role: row[5] as FamilyMember['role'] }
}

function serializeReminder(r: FamilyReminder): string[] {
  return [r.id, r.title, r.dueDate ?? '', r.isCompleted ? '1' : '0', r.completedAt ?? '', r.priority, r.notes ?? '', r.assigneeEmail ?? '', r.recurrence ? JSON.stringify(r.recurrence) : '']
}
function deserializeReminder(row: string[]): FamilyReminder {
  return {
    id: row[0], title: row[1], dueDate: row[2] || undefined, isCompleted: row[3] === '1',
    completedAt: row[4] || undefined, priority: (row[5] || 'none') as FamilyReminder['priority'],
    notes: row[6] || undefined, assigneeEmail: row[7] || undefined,
    recurrence: row[8] ? JSON.parse(row[8]) : undefined,
  }
}

function serializeChore(c: Chore): string[] {
  return [c.id, c.name, c.assigneeEmail, c.colorHex, JSON.stringify(c.recurrence), c.lastCompletedDate ?? '', String(c.streak)]
}
function deserializeChore(row: string[]): Chore {
  return {
    id: row[0], name: row[1], assigneeEmail: row[2], colorHex: row[3],
    recurrence: JSON.parse(row[4] || '{"frequency":"weekly","interval":1}'),
    lastCompletedDate: row[5] || undefined, streak: parseInt(row[6] || '0', 10),
  }
}

function serializeChecklist(c: Checklist): string[] {
  return [c.id, c.name, c.colorHex, JSON.stringify(c.items), c.createdAt]
}
function deserializeChecklist(row: string[]): Checklist {
  return { id: row[0], name: row[1], colorHex: row[2], items: JSON.parse(row[3] || '[]'), createdAt: row[4] }
}

function serializeShoppingList(s: ShoppingList): string[] {
  return [s.id, s.name, s.store ?? '', s.colorHex, JSON.stringify(s.items)]
}
function deserializeShoppingList(row: string[]): ShoppingList {
  return { id: row[0], name: row[1], store: row[2] || undefined, colorHex: row[3], items: JSON.parse(row[4] || '[]') }
}

function serializeMealPlan(m: MealPlan): string[] {
  return [m.id, m.date, m.mealName, JSON.stringify(m.ingredients), m.notes ?? '']
}
function deserializeMealPlan(row: string[]): MealPlan {
  return { id: row[0], date: row[1], mealName: row[2], ingredients: JSON.parse(row[3] || '[]'), notes: row[4] || undefined }
}

function serializeTemplate(t: Template): string[] {
  return [t.id, t.name, t.kind, t.colorHex, JSON.stringify(t.items)]
}
function deserializeTemplate(row: string[]): Template {
  return { id: row[0], name: row[1], kind: row[2] as Template['kind'], colorHex: row[3], items: JSON.parse(row[4] || '[]') }
}

const deserializers: Record<SheetTab, (row: string[]) => unknown> = {
  family: deserializeMember,
  reminders: deserializeReminder,
  chores: deserializeChore,
  checklists: deserializeChecklist,
  shopping_lists: deserializeShoppingList,
  meal_plans: deserializeMealPlan,
  templates: deserializeTemplate,
  push_subscriptions: (row) => ({ userEmail: row[0], subscription: row[1] }),
}

const serializers: Record<string, (item: unknown) => string[]> = {
  family: (m) => serializeMember(m as FamilyMember),
  reminders: (r) => serializeReminder(r as FamilyReminder),
  chores: (c) => serializeChore(c as Chore),
  checklists: (c) => serializeChecklist(c as Checklist),
  shopping_lists: (s) => serializeShoppingList(s as ShoppingList),
  meal_plans: (m) => serializeMealPlan(m as MealPlan),
  templates: (t) => serializeTemplate(t as Template),
  push_subscriptions: (p) => [(p as { userEmail: string }).userEmail, (p as { subscription: string }).subscription],
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tab = new URL(req.url).searchParams.get('tab') as SheetTab
  if (!tab) return NextResponse.json({ error: 'Missing tab' }, { status: 400 })

  const rows = await readSheet(session.accessToken, tab)
  const data = rows.slice(1).filter((r) => r.length > 0 && r[0]).map(deserializers[tab])
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tab, item } = await req.json() as { tab: SheetTab; item: Record<string, unknown> }
  if (!item.id) item.id = generateId()
  const row = serializers[tab](item)
  await appendRow(session.accessToken, tab, row)
  return NextResponse.json(item)
}

export async function PUT(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tab, item } = await req.json() as { tab: SheetTab; item: Record<string, unknown> }
  const row = serializers[tab](item)
  await upsertRow(session.accessToken, tab, item.id as string, row)
  return NextResponse.json(item)
}

export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tab, id } = await req.json() as { tab: SheetTab; id: string }
  const idx = await findRowById(session.accessToken, tab, id)
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await deleteRow(session.accessToken, tab, idx)
  return NextResponse.json({ ok: true })
}
