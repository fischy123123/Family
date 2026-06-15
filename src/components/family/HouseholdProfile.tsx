'use client'

import { useEffect, useState } from 'react'
import { Compass, Check, Loader2, Plus, X } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import type { FamilyProfile } from '@/lib/types'

const PROFILE_ID = 'household'

// The "lens" the assistant reasons through. Editing here changes how every
// briefing is prioritized — what gets surfaced and what stays quiet.
export function HouseholdProfile() {
  const { data: profiles, create } = useFirestore<FamilyProfile>('profile')
  const { toast } = useToast()
  const existing = profiles[0] ?? null

  const [household, setHousehold] = useState('')
  const [priorities, setPriorities] = useState<string[]>([])
  const [concerns, setConcerns] = useState<string[]>([])
  const [style, setStyle] = useState<FamilyProfile['communicationStyle']>('balanced')
  const [quietHours, setQuietHours] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Hydrate from the stored profile once it loads (and whenever it changes
  // underneath us), unless the user has unsaved edits in progress.
  useEffect(() => {
    if (dirty || !existing) return
    setHousehold(existing.household ?? '')
    setPriorities(existing.priorities ?? [])
    setConcerns(existing.concerns ?? [])
    setStyle(existing.communicationStyle ?? 'balanced')
    setQuietHours(existing.quietHours ?? '')
  }, [existing, dirty])

  function mark<T>(setter: (v: T) => void) {
    return (v: T) => { setDirty(true); setter(v) }
  }

  async function save() {
    setSaving(true)
    try {
      await create({
        id: PROFILE_ID,
        household: household.trim() || undefined,
        priorities: priorities.filter(Boolean),
        concerns: concerns.filter(Boolean),
        communicationStyle: style,
        quietHours: quietHours.trim() || undefined,
        updatedAt: new Date().toISOString(),
      } as FamilyProfile)
      setDirty(false)
      toast('Profile saved — your assistant will use this', 'success')
    } catch {
      toast('Could not save profile', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5 mb-6 animate-scale-in">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <Compass size={16} className="text-indigo-600" />
        </div>
        <h2 className="text-base font-bold text-slate-900">How your assistant should think</h2>
      </div>
      <p className="text-xs text-slate-500 mb-4 ml-10">
        This is the lens. It decides what gets surfaced and what stays quiet.
      </p>

      <div className="space-y-4">
        <Field label="Who you are">
          <textarea
            value={household}
            onChange={(e) => mark(setHousehold)(e.target.value)}
            placeholder="e.g. Two working parents, kids Mia (8) and Leo (5), in Seattle. Both parents commute downtown."
            rows={2}
            className="w-full input-premium px-3 py-2 text-sm text-slate-800 resize-none"
          />
        </Field>

        <Field label="What matters most" hint="The things you never want to drop">
          <TagList values={priorities} onChange={mark(setPriorities)} placeholder="e.g. Never miss the kids' events" accent="#16a34a" />
        </Field>

        <Field label="What to watch for" hint="Stressors the assistant should flag early">
          <TagList values={concerns} onChange={mark(setConcerns)} placeholder="e.g. Bills, being late, medical appts" accent="#dc2626" />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Briefing tone">
            <div className="flex gap-1.5">
              {(['brief', 'balanced', 'detailed'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => mark(setStyle)(s)}
                  className={`flex-1 px-2 py-2 rounded-xl text-xs font-medium capitalize transition-colors border ${
                    style === s
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Quiet hours" hint="When not to surface non-urgent things">
            <input
              value={quietHours}
              onChange={(e) => mark(setQuietHours)(e.target.value)}
              placeholder="e.g. After 8pm, weekend mornings"
              className="w-full input-premium px-3 py-2 text-sm text-slate-800"
            />
          </Field>
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving || !dirty}
        className="mt-5 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 transition-all"
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
        {saving ? 'Saving…' : dirty ? 'Save profile' : 'Saved'}
      </button>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1.5">
        {label}
        {hint && <span className="font-normal text-slate-400"> · {hint}</span>}
      </label>
      {children}
    </div>
  )
}

// A simple add-as-you-go chip editor backed by a string array.
function TagList({
  values, onChange, placeholder, accent,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder: string
  accent: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v) return
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map((v, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium"
              style={{ background: `${accent}15`, color: accent }}
            >
              {v}
              <button onClick={() => onChange(values.filter((_, j) => j !== i))} className="opacity-60 hover:opacity-100">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={placeholder}
          className="flex-1 input-premium px-3 py-2 text-sm text-slate-800"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="shrink-0 px-3 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}
