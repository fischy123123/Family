import useSWR, { mutate } from 'swr'
import type { SheetTab } from '@/lib/google/sheets'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useSheetsData<T>(tab: SheetTab) {
  const key = `/api/sheets?tab=${tab}`
  const { data, error, isLoading } = useSWR<T[]>(key, fetcher)

  async function create(item: Omit<T, 'id'> & { id?: string }) {
    const res = await fetch('/api/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, item }),
    })
    await mutate(key)
    return res.json()
  }

  async function update(item: T) {
    await fetch('/api/sheets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, item }),
    })
    await mutate(key)
  }

  async function remove(id: string) {
    await fetch('/api/sheets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, id }),
    })
    await mutate(key)
  }

  return { data: data ?? [], error, isLoading, create, update, remove, mutate: () => mutate(key) }
}
