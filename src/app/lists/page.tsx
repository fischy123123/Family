import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { ListsPage } from '@/components/lists/ListsPage'

export default async function Lists() {
  const session = await auth()
  if (!session) redirect('/signin')

  return (
    <AppShell>
      <ListsPage />
    </AppShell>
  )
}
