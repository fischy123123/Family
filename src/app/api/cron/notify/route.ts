import { NextRequest, NextResponse } from 'next/server'
import { readSheet } from '@/lib/google/sheets'
import { sendPushNotification } from '@/lib/push'
import { isDueToday } from '@/lib/recurrence'
import type { FamilyReminder, Chore } from '@/lib/types'

// Called by Vercel Cron — no user session needed, uses a service-level token
// For simplicity, reminders/chores are read from the first family member's token
// stored in env (or we use a service account pattern with the cron secret)
export async function GET(req: NextRequest) {
  // Vercel Cron sends a special auth header
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Use a dedicated service access token stored as env var for cron reads
  const serviceToken = process.env.CRON_GOOGLE_ACCESS_TOKEN
  if (!serviceToken) {
    return NextResponse.json({ ok: true, message: 'No service token configured, skipping' })
  }

  const [reminderRows, choreRows, subRows] = await Promise.all([
    readSheet(serviceToken, 'reminders'),
    readSheet(serviceToken, 'chores'),
    readSheet(serviceToken, 'push_subscriptions'),
  ])

  const reminders: FamilyReminder[] = reminderRows.slice(1)
    .filter((r) => r.length > 0 && r[0] && r[3] !== '1')
    .map((row) => ({
      id: row[0], title: row[1], dueDate: row[2] || undefined, isCompleted: false,
      priority: (row[5] || 'none') as FamilyReminder['priority'],
      recurrence: row[8] ? JSON.parse(row[8]) : undefined,
    }))

  const chores: Chore[] = choreRows.slice(1)
    .filter((r) => r.length > 0 && r[0])
    .map((row) => ({
      id: row[0], name: row[1], assigneeEmail: row[2], colorHex: row[3],
      recurrence: JSON.parse(row[4] || '{"frequency":"daily","interval":1}'),
      lastCompletedDate: row[5] || undefined,
      streak: parseInt(row[6] || '0', 10),
    }))

  const subscriptions = subRows.slice(1).filter((r) => r.length >= 2)

  const dueReminders = reminders.filter((r) => {
    if (r.recurrence) return isDueToday(r.recurrence, r.dueDate)
    return r.dueDate && new Date(r.dueDate) <= new Date()
  })

  const dueChores = chores.filter((c) => isDueToday(c.recurrence, c.lastCompletedDate))

  const notifications: { title: string; body: string }[] = [
    ...dueReminders.map((r) => ({ title: '⏰ Reminder', body: r.title })),
    ...dueChores.map((c) => ({ title: '🧹 Chore Due', body: c.name })),
  ]

  if (notifications.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  let sent = 0
  for (const sub of subscriptions) {
    for (const notif of notifications) {
      try {
        await sendPushNotification(sub[1], { ...notif, url: '/dashboard' })
        sent++
      } catch {
        // Subscription may be expired — ignore
      }
    }
  }

  return NextResponse.json({ ok: true, sent })
}
