import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { FamilyCalendar } from '@/components/calendar/FamilyCalendar'

export default async function CalendarPage() {
  const session = await auth()
  if (!session) redirect('/signin')

  return (
    <AppShell>
      <FamilyCalendar />
    </AppShell>
  )
}
