import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/components/dashboard/DashboardPage'

export default async function Dashboard() {
  const session = await auth()
  if (!session) redirect('/signin')

  return (
    <AppShell>
      <DashboardPage />
    </AppShell>
  )
}
