'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { MEMBER_COLORS } from '@/lib/types'
import type { Template } from '@/lib/types'
import { generateId } from '@/lib/utils'

interface TemplateFormProps {
  open: boolean
  onClose: () => void
  template?: Template
  onSave: (t: Template) => Promise<void>
}

export function TemplateForm({ open, onClose, template, onSave }: TemplateFormProps) {
  const [name, setName] = useState(template?.name ?? '')
  const [kind, setKind] = useState<Template['kind']>(template?.kind ?? 'checklist')
  const [colorHex, setColorHex] = useState(template?.colorHex ?? MEMBER_COLORS[0])
  const [items, setItems] = useState<string[]>(template?.items ?? [''])
  const [saving, setSaving] = useState(false)

  function addItem() { setItems([...items, '']) }
  function removeItem(i: number) { setItems(items.filter((_, idx) => idx !== i)) }
  function updateItem(i: number, v: string) { setItems(items.map((item, idx) => (idx === i ? v : item))) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const validItems = items.filter((i) => i.trim())
    try {
      await onSave({ id: template?.id ?? generateId(), name, kind, colorHex, items: validItems })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={template ? 'Edit Template' : 'New Template'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required />

        <Select value={kind} onChange={(e) => setKind(e.target.value as Template['kind'])}>
          <option value="checklist">Checklist Template</option>
          <option value="shopping">Shopping Template</option>
        </Select>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Color</p>
          <div className="flex flex-wrap gap-2">
            {MEMBER_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColorHex(c)}
                className={`w-6 h-6 rounded-full border-2 ${colorHex === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Items</p>
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder={`Item ${i + 1}`}
                  value={item}
                  onChange={(e) => updateItem(i, e.target.value)}
                />
                <Button type="button" size="icon" variant="ghost" onClick={() => removeItem(i)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" onClick={addItem}>
              <Plus size={14} className="mr-1" /> Add Item
            </Button>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving} className="flex-1">{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  )
}
