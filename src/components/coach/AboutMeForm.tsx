'use client'

import { useState } from 'react'
import { Check, User, Sun, Users, SlidersHorizontal } from 'lucide-react'
import type { PersonalProfile } from '@/lib/types'

const PLAN_STYLES: { key: NonNullable<PersonalProfile['planStyle']>; label: string; hint: string }[] = [
  { key: 'minimal', label: 'Light', hint: 'few things, lots of space' },
  { key: 'balanced', label: 'Balanced', hint: 'a handful with slack' },
  { key: 'packed', label: 'Full', hint: 'pack it in' },
]

const linesToArr = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

// The full "About me & my days" editor — everything the planner and Moment
// Coach use to make their guidance feel like it actually knows you. All
// optional; save anytime. Writes the per-person PersonalProfile.
export function AboutMeForm({
  existing, onSave, onCancel,
}: {
  existing: PersonalProfile | null
  onSave: (patch: Partial<PersonalProfile>) => void
  onCancel?: () => void
}) {
  const [goals, setGoals] = useState((existing?.goals ?? []).join('\n'))
  const [biggestStruggle, setBiggestStruggle] = useState(existing?.biggestStruggle ?? '')
  const [hasAdhd, setHasAdhd] = useState(existing?.hasAdhd ?? false)
  const [startStrategies, setStartStrategies] = useState((existing?.startStrategies ?? []).join('\n'))

  const [rhythm, setRhythm] = useState(existing?.rhythm ?? '')
  const [fixedAnchors, setFixedAnchors] = useState((existing?.fixedAnchors ?? []).join('\n'))

  const [householdRoles, setHouseholdRoles] = useState(existing?.householdRoles ?? '')
  const [careSchedule, setCareSchedule] = useState(existing?.careSchedule ?? '')

  const [planStyle, setPlanStyle] = useState<PersonalProfile['planStyle']>(existing?.planStyle)
  const [protectRest, setProtectRest] = useState(existing?.protectRest ?? false)
  const [nonNegotiables, setNonNegotiables] = useState((existing?.nonNegotiables ?? []).join('\n'))

  const [freeform, setFreeform] = useState(existing?.freeform ?? '')

  function save() {
    onSave({
      goals: linesToArr(goals),
      biggestStruggle: biggestStruggle.trim() || undefined,
      hasAdhd,
      startStrategies: linesToArr(startStrategies),
      rhythm: rhythm.trim() || undefined,
      fixedAnchors: linesToArr(fixedAnchors),
      householdRoles: householdRoles.trim() || undefined,
      careSchedule: careSchedule.trim() || undefined,
      planStyle,
      protectRest,
      nonNegotiables: linesToArr(nonNegotiables),
      freeform: freeform.trim() || undefined,
    })
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 leading-relaxed">
        The more I know, the better your plans fit. All optional — fill in what helps, skip the rest.
      </p>

      {/* You */}
      <Section icon={User} color="#6366F1" title="You">
        <Field label="What are you working toward?" hint="one per line">
          <Textarea value={goals} onChange={setGoals} rows={3} placeholder={'Be more present with the kids\nGet back to the gym'} />
        </Field>
        <Field label="What most gets in your way?">
          <Input value={biggestStruggle} onChange={setBiggestStruggle} placeholder="e.g. I freeze when there's too much and never start" />
        </Field>
        <Toggle checked={hasAdhd} onChange={() => setHasAdhd((v) => !v)} label="I have ADHD / struggle to get started — lean on tiny first steps" />
        <Field label="What actually helps you start?" hint="one per line">
          <Textarea value={startStrategies} onChange={setStartStrategies} rows={2} placeholder={'Body-double on a call\nSet a 10-min timer'} />
        </Field>
      </Section>

      {/* Your days */}
      <Section icon={Sun} color="#F59E0B" title="Your days">
        <Field label="When do you focus best vs. crash?">
          <Input value={rhythm} onChange={setRhythm} placeholder="e.g. Sharp 6–9am, fried after lunch, second wind at 8pm" />
        </Field>
        <Field label="Fixed daily anchors that aren't on your calendar" hint="one per line — pickup, work hours, bedtime, meds">
          <Textarea value={fixedAnchors} onChange={setFixedAnchors} rows={3} placeholder={'School drop-off 8:10\nPickup 3:30\nWork 9–5\nKids bedtime 8pm'} />
        </Field>
      </Section>

      {/* Household */}
      <Section icon={Users} color="#EC4899" title="Household">
        <Field label="Who does what by default?">
          <Textarea value={householdRoles} onChange={setHouseholdRoles} rows={2} placeholder="e.g. I do mornings + pickup; my partner does dinner + bedtime" />
        </Field>
        <Field label="Which days do you have the kids? Partner's schedule?">
          <Textarea value={careSchedule} onChange={setCareSchedule} rows={2} placeholder="e.g. I have the kids Mon/Wed/Fri; partner travels Tue–Thu" />
        </Field>
      </Section>

      {/* Plan style */}
      <Section icon={SlidersHorizontal} color="#3B82F6" title="How you like your days planned">
        <Field label="How full should a day feel?">
          <div className="grid grid-cols-3 gap-2">
            {PLAN_STYLES.map((s) => {
              const active = planStyle === s.key
              return (
                <button
                  key={s.key}
                  onClick={() => setPlanStyle(active ? undefined : s.key)}
                  className={`rounded-xl py-2 px-1 flex flex-col items-center gap-0.5 border transition-all ${
                    active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <span className="text-xs font-semibold">{s.label}</span>
                  <span className="text-[10px] text-slate-400 leading-tight text-center">{s.hint}</span>
                </button>
              )
            })}
          </div>
        </Field>
        <Toggle checked={protectRest} onChange={() => setProtectRest((v) => !v)} label="Protect rest — build real downtime into my day" />
        <Field label="Non-negotiables" hint="hard rules I should never break — one per line">
          <Textarea value={nonNegotiables} onChange={setNonNegotiables} rows={2} placeholder={'Nothing scheduled after 8pm bedtime\nKeep Sunday mornings free'} />
        </Field>
      </Section>

      <Field label="Anything else I should know?" hint="optional">
        <Textarea value={freeform} onChange={setFreeform} rows={2} placeholder="What drains you, what you keep avoiding, anything at all…" />
      </Field>

      <div className="flex items-center gap-2 sticky bottom-0 bg-white pt-2">
        {onCancel && (
          <button onClick={onCancel} className="px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors">
            Cancel
          </button>
        )}
        <button onClick={save} className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.99] transition-transform">
          <Check size={16} /> Save
        </button>
      </div>
    </div>
  )
}

function Section({ icon: Icon, color, title, children }: { icon: typeof User; color: string; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
          <Icon size={14} style={{ color }} />
        </span>
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      </div>
      <div className="space-y-3 pl-0.5">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1.5">
        {label}{hint && <span className="font-normal text-slate-400"> · {hint}</span>}
      </label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50"
    />
  )
}

function Textarea({ value, onChange, rows, placeholder }: { value: string; onChange: (v: string) => void; rows: number; placeholder?: string }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className="w-full text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50 resize-none leading-relaxed"
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button onClick={onChange} className="flex items-center gap-2.5 w-full text-left">
      <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-indigo-600' : 'bg-white border border-slate-300'}`}>
        {checked && <Check size={13} className="text-white" />}
      </span>
      <span className="text-sm text-slate-600">{label}</span>
    </button>
  )
}
