'use client'

export const dynamic = 'force-dynamic'

import { AppShell } from '@/components/layout/AppShell'
import { FamilyCalendar } from '@/components/calendar/FamilyCalendar'

export default function CalendarPage() {
  return (
    <AppShell>
      <FamilyCalendar />
    </AppShell>
  )
}
