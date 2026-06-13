'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Plus, Trash2, Bell, Users, PartyPopper } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { MEMBER_COLORS } from '@/lib/types'
import type { FamilyMember } from '@/lib/types'
import { generateId } from '@/lib/utils'
import { enableNotifications, notificationsSupported } from '@/lib/messaging'

const EMOJIS = ['👨', '👩', '🧑', '👦', '👧', '👶', '🧓', '👴', '👵', '🧒']

export default function OnboardingPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  const { familyId, inviteCode } = useFamily()
  const { data: members, create: createMember, remove: removeMember } = useFirestore<FamilyMember>('members')
  const { toast } = useToast()

  const [step, setStep] = useState(0)
  const [copied, setCopied] = useState(false)
  const [notifSupported, setNotifSupported] = useState(false)

  // New member form state
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<FamilyMember['role']>('parent')
  const [emoji, setEmoji] = useState('👤')
  const [colorHex, setColorHex] = useState(MEMBER_COLORS[0])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.replace('/signin')
  }, [user, loading, router])

  useEffect(() => {
    notificationsSupported().then(setNotifSupported)
  }, [])

  function copyCode() {
    if (!inviteCode) return
    navigator.clipboard.writeText(inviteCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await createMember({
        id: generateId(),
        name: name.trim(),
        email: email.trim(),
        role, emoji, colorHex,
      })
      setName(''); setEmail(''); setEmoji('👤')
      setColorHex(MEMBER_COLORS[(members.length + 1) % MEMBER_COLORS.length])
      toast('Member added', 'success')
    } finally {
      setSaving(false)
    }
  }

  async function turnOnNotifications() {
    if (!familyId || !user?.email) return
    try {
      await enableNotifications(familyId, user.email)
      toast('Notifications enabled!', 'success')
      setStep(3)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Could not enable', 'error')
    }
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const steps = ['Welcome', 'Family', 'Alerts', 'Done']

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-fade-in">
        {/* Progress */}
        <div className="flex gap-1 p-4 pb-0">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? 'bg-blue-500' : 'bg-gray-200'}`}
            />
          ))}
        </div>

        <div className="p-6">
          {/* Step 0 — Welcome + invite code */}
          {step === 0 && (
            <div className="text-center">
              <div className="text-5xl mb-3">🏠</div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Your family space is ready!</h1>
              <p className="text-gray-500 text-sm mb-6">
                Share this code with your partner or family so they can join the same space.
              </p>
              <div className="bg-blue-50 rounded-xl border border-blue-100 p-5 mb-6">
                <p className="text-xs text-blue-500 font-medium uppercase tracking-wider mb-2">Invite Code</p>
                <div className="flex items-center justify-center gap-3">
                  <span className="text-3xl font-mono font-bold text-blue-700 tracking-widest">{inviteCode}</span>
                  <button onClick={copyCode} className="p-2 rounded-lg hover:bg-blue-100 text-blue-600">
                    {copied ? <Check size={20} /> : <Copy size={20} />}
                  </button>
                </div>
              </div>
              <Button size="lg" className="w-full" onClick={() => setStep(1)}>Get Started</Button>
            </div>
          )}

          {/* Step 1 — Add family members */}
          {step === 1 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Users size={20} className="text-blue-500" />
                <h1 className="text-xl font-bold text-gray-900">Add family members</h1>
              </div>
              <p className="text-gray-500 text-sm mb-4">
                Add everyone in your household. Each person gets a color and emoji used across the calendar and chores.
              </p>

              {members.length > 0 && (
                <div className="space-y-2 mb-4">
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 p-2 rounded-lg bg-gray-50">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-base" style={{ backgroundColor: `${m.colorHex}25` }}>
                        {m.emoji}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800">{m.name}</p>
                        <p className="text-xs text-gray-400 capitalize">{m.role}</p>
                      </div>
                      <button onClick={() => removeMember(m.id)} className="text-gray-300 hover:text-red-400">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={addMember} className="space-y-3 border-t border-gray-100 pt-4">
                <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input placeholder="Google email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Select value={role} onChange={(e) => setRole(e.target.value as FamilyMember['role'])}>
                  <option value="parent">Parent</option>
                  <option value="child">Child</option>
                  <option value="other">Other</option>
                </Select>
                <div className="flex flex-wrap gap-1.5">
                  {EMOJIS.map((em) => (
                    <button key={em} type="button" onClick={() => setEmoji(em)}
                      className={`text-lg p-1 rounded-lg border-2 ${emoji === em ? 'border-blue-500 bg-blue-50' : 'border-transparent'}`}>
                      {em}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {MEMBER_COLORS.map((c) => (
                    <button key={c} type="button" onClick={() => setColorHex(c)}
                      className={`w-6 h-6 rounded-full border-2 ${colorHex === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
                <Button type="submit" variant="secondary" disabled={saving} className="w-full">
                  <Plus size={16} className="mr-1" /> {saving ? 'Adding…' : 'Add member'}
                </Button>
              </form>

              <div className="flex gap-2 mt-5">
                <Button variant="ghost" onClick={() => setStep(2)} className="flex-1">Skip</Button>
                <Button onClick={() => setStep(2)} className="flex-1" disabled={members.length === 0}>Next</Button>
              </div>
            </div>
          )}

          {/* Step 2 — Notifications */}
          {step === 2 && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-blue-100 flex items-center justify-center mx-auto mb-4">
                <Bell size={26} className="text-blue-600" />
              </div>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Stay in the loop</h1>
              <p className="text-gray-500 text-sm mb-6">
                Get a daily morning agenda and reminders for events and chores right on your phone.
              </p>
              {notifSupported ? (
                <Button size="lg" className="w-full mb-2" onClick={turnOnNotifications}>
                  Enable Notifications
                </Button>
              ) : (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-3 mb-2">
                  To get push notifications on iPhone, first add this app to your Home Screen
                  (Share → Add to Home Screen), then open it and enable notifications from the dashboard.
                </p>
              )}
              <Button variant="ghost" className="w-full" onClick={() => setStep(3)}>Maybe later</Button>
            </div>
          )}

          {/* Step 3 — Done */}
          {step === 3 && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
                <PartyPopper size={26} className="text-green-600" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">You&apos;re all set!</h1>
              <p className="text-gray-500 text-sm mb-6">
                Try the Quick Add bar on your dashboard — just type things like
                &quot;dentist for Mia next Tuesday at 3pm&quot; and the AI will sort it out.
              </p>
              <Button size="lg" className="w-full" onClick={() => router.replace('/dashboard')}>
                Go to Dashboard
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
