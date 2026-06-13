import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { FamilyPage } from '@/components/family/FamilyPage'

export default async function Family() {
  const session = await auth()
  if (!session) redirect('/signin')

  return (
    <AppShell>
      <FamilyPage />
    </AppShell>
  )
}
