import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { TasksPage } from '@/components/tasks/TasksPage'

export default async function Tasks() {
  const session = await auth()
  if (!session) redirect('/signin')

  return (
    <AppShell>
      <TasksPage />
    </AppShell>
  )
}
