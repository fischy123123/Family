'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Plus, Trash2, Bell, Users, PartyPopper, Calendar } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Select } from '@/components/ui/select'
import { MEMBER_COLORS } from '@/lib/types'
import type { FamilyMember } from '@/lib/types'
import { generateId } from '@/lib/utils'
import { enableNotifications, getNotificationStatus } from '@/lib/messaging'

const EMOJIS = ['👨', '👩', '🧑', '👦', '👧', '👶', '🧓', '👴', '👵', '🧒']

export default function OnboardingPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  const { familyId, inviteCode } = useFamily()
  const { data: members, create: createMember, update: updateMember, remove: removeMember } = useFirestore<FamilyMember>('members')
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

  // Per-member profile state (step 2)
  const [profileStep, setProfileStep] = useState(0)
  const [profileWhat, setProfileWhat] = useState('')
  const [profileSchedule, setProfileSchedule] = useState('')
  const [profileImportant, setProfileImportant] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)

  // Google Calendar step state (step 3)
  const [calendarRedirecting, setCalendarRedirecting] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.replace('/signin')
  }, [user, loading, router])

  useEffect(() => {
    getNotificationStatus().then((s) => setNotifSupported(s !== 'unsupported'))
  }, [])

  // Reset profile fields when moving to a new member
  function resetProfileFields() {
    setProfileWhat('')
    setProfileSchedule('')
    setProfileImportant('')
  }

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
      // Pick next color based on current members count (after adding, it'll be members.length+1)
      setColorHex(MEMBER_COLORS[(members.length + 1) % MEMBER_COLORS.length])
      toast('Member added', 'success')
    } finally {
      setSaving(false)
    }
  }

  function goToStep2() {
    // If no members, skip straight to step 3
    if (members.length === 0) {
      setStep(3)
      return
    }
    setProfileStep(0)
    resetProfileFields()
    setStep(2)
  }

  async function saveProfileAndNext() {
    const member = members[profileStep]
    if (!member) return
    setProfileSaving(true)
    try {
      await updateMember({
        ...member,
        summary: profileWhat.trim(),
        routines: profileSchedule.trim(),
        importantInfo: profileImportant.trim(),
      } as FamilyMember & { summary: string; routines: string; importantInfo: string })
    } finally {
      setProfileSaving(false)
    }
    advanceProfile()
  }

  function skipProfile() {
    advanceProfile()
  }

  function advanceProfile() {
    const nextIndex = profileStep + 1
    if (nextIndex >= members.length) {
      setStep(3)
    } else {
      setProfileStep(nextIndex)
      resetProfileFields()
    }
  }

  async function turnOnNotifications() {
    if (!familyId || !user?.email) return
    try {
      await enableNotifications(familyId, user.email)
      toast('Notifications enabled!', 'success')
      setStep(5)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Could not enable', 'error')
    }
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const steps = ['Welcome', 'Family', 'Profiles', 'Calendar', 'Alerts', 'Done']

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden bg-slate-900">
      {/* Orb background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -right-40 w-80 h-80 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 left-1/3 w-64 h-64 bg-purple-600/15 rounded-full blur-3xl" />
      </div>

      <div
        className="relative w-full max-w-md overflow-hidden animate-fade-in rounded-2xl border border-white/10"
        style={{ background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(24px)' }}
      >
        {/* Progress bar */}
        <div className="flex gap-1 p-4 pb-0">
          {steps.map((_, i) => (
            <div key={i} className="h-1.5 flex-1 rounded-full overflow-hidden bg-white/10">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: i <= step ? '100%' : '0%',
                  background: 'linear-gradient(to right, #60a5fa, #a78bfa)',
                }}
              />
            </div>
          ))}
        </div>

        <div className="p-6">
          {/* Step 0 — Welcome + invite code */}
          {step === 0 && (
            <div className="text-center">
              <div className="text-6xl mb-4 animate-bounce" style={{ animationDuration: '2s' }}>🏠</div>
              <h1 className="text-2xl font-bold text-white mb-2">Your family space is ready!</h1>
              <p className="text-slate-400 text-sm mb-8">
                Share this code with your partner or family so they can join the same space.
              </p>
              {/* Invite code — dramatic presentation */}
              <div
                className="relative rounded-2xl border border-blue-400/30 p-6 mb-8 overflow-hidden"
                style={{ background: 'rgba(59,130,246,0.12)' }}
              >
                {/* Pulsing glow ring */}
                <div className="absolute inset-0 rounded-2xl" style={{
                  boxShadow: '0 0 0 1px rgba(96,165,250,0.3), 0 0 40px rgba(96,165,250,0.15)',
                  animation: 'pulse 2.5s ease-in-out infinite',
                }} />
                <p className="text-xs text-blue-400 font-semibold uppercase tracking-widest mb-3">Invite Code</p>
                <div className="flex items-center justify-center gap-4">
                  <span className="text-4xl font-mono font-black text-white tracking-[0.25em]">{inviteCode}</span>
                  <button
                    onClick={copyCode}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-blue-300 border border-blue-400/30 hover:bg-blue-400/10 transition-all"
                  >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <button
                onClick={() => setStep(1)}
                className="w-full py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
              >
                Get Started
              </button>
            </div>
          )}

          {/* Step 1 — Add family members */}
          {step === 1 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.2)' }}>
                  <Users size={14} className="text-blue-400" />
                </div>
                <h1 className="text-xl font-bold text-white">Add family members</h1>
              </div>
              <p className="text-slate-400 text-sm mb-4">
                Add everyone in your household. Each person gets a color and emoji used across the calendar and chores.
              </p>

              {members.length > 0 && (
                <div className="space-y-2 mb-4">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-3 p-2.5 rounded-xl border border-white/10"
                      style={{ background: 'rgba(255,255,255,0.05)' }}
                    >
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ backgroundColor: `${m.colorHex}30` }}>
                        {m.emoji}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white">{m.name}</p>
                        <p className="text-xs text-slate-400 capitalize">{m.role}</p>
                      </div>
                      <button onClick={() => removeMember(m.id)} className="text-slate-600 hover:text-red-400 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={addMember} className="space-y-3 border-t border-white/10 pt-4">
                <input
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-500 border border-white/10 focus:outline-none focus:border-blue-400/50 transition-colors"
                  style={{ background: 'rgba(255,255,255,0.07)' }}
                />
                <input
                  placeholder="Google email (optional)"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-500 border border-white/10 focus:outline-none focus:border-blue-400/50 transition-colors"
                  style={{ background: 'rgba(255,255,255,0.07)' }}
                />
                <Select
                  value={role}
                  onChange={(e) => setRole(e.target.value as FamilyMember['role'])}
                  className="bg-transparent text-white border-white/10"
                >
                  <option value="parent">Parent</option>
                  <option value="child">Child</option>
                  <option value="other">Other</option>
                </Select>
                <div className="flex flex-wrap gap-1.5">
                  {EMOJIS.map((em) => (
                    <button key={em} type="button" onClick={() => setEmoji(em)}
                      className={`text-lg p-1.5 rounded-lg border-2 transition-all ${emoji === em ? 'border-blue-400 bg-blue-400/10' : 'border-transparent hover:bg-white/5'}`}>
                      {em}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {MEMBER_COLORS.map((c) => (
                    <button key={c} type="button" onClick={() => setColorHex(c)}
                      className={`w-6 h-6 rounded-full border-2 transition-transform ${colorHex === c ? 'border-white scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-white border border-white/20 hover:bg-white/10 disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(255,255,255,0.07)' }}
                >
                  <Plus size={16} /> {saving ? 'Adding…' : 'Add member'}
                </button>
              </form>

              <div className="flex gap-2 mt-5">
                <button
                  onClick={goToStep2}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-400 border border-white/10 hover:bg-white/5 transition-all"
                >
                  Skip
                </button>
                <button
                  onClick={goToStep2}
                  disabled={members.length === 0}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-all hover:opacity-90"
                  style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {/* Step 2 — Per-member quick profiles */}
          {step === 2 && members[profileStep] && (
            <div>
              {/* Progress indicator within step */}
              {members.length > 1 && (
                <div className="flex gap-1 mb-4">
                  {members.map((_, i) => (
                    <div key={i} className="h-1 flex-1 rounded-full overflow-hidden bg-white/10">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: i <= profileStep ? '100%' : '0%',
                          background: 'linear-gradient(to right, #60a5fa, #a78bfa)',
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              <h1 className="text-xl font-bold text-white mb-1">
                Tell us about {members[profileStep].emoji} {members[profileStep].name}
              </h1>
              <p className="text-slate-400 text-xs mb-5">
                {profileStep + 1} of {members.length} — helps the AI give smarter suggestions
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">What do they do?</label>
                  <textarea
                    value={profileWhat}
                    onChange={(e) => setProfileWhat(e.target.value)}
                    placeholder="e.g. 3rd grader at Lincoln Elementary, Works downtown as a nurse"
                    rows={2}
                    className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-500 border border-white/10 focus:outline-none focus:border-blue-400/50 transition-colors resize-none"
                    style={{ background: 'rgba(255,255,255,0.07)' }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Typical daily schedule?</label>
                  <textarea
                    value={profileSchedule}
                    onChange={(e) => setProfileSchedule(e.target.value)}
                    placeholder="e.g. School 8am-3pm, soccer practice Tuesdays 4pm"
                    rows={2}
                    className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-500 border border-white/10 focus:outline-none focus:border-blue-400/50 transition-colors resize-none"
                    style={{ background: 'rgba(255,255,255,0.07)' }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Anything important to know?</label>
                  <textarea
                    value={profileImportant}
                    onChange={(e) => setProfileImportant(e.target.value)}
                    placeholder="e.g. Nut allergy, vegetarian, loves reading"
                    rows={2}
                    className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-500 border border-white/10 focus:outline-none focus:border-blue-400/50 transition-colors resize-none"
                    style={{ background: 'rgba(255,255,255,0.07)' }}
                  />
                </div>
              </div>

              <div className="mt-5 space-y-2">
                <button
                  onClick={saveProfileAndNext}
                  disabled={profileSaving}
                  className="w-full py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
                >
                  {profileSaving ? 'Saving…' : (profileStep + 1 < members.length ? 'Save & Next' : 'Save & Continue')}
                </button>
                <button
                  onClick={skipProfile}
                  className="w-full py-2 text-sm text-slate-400 hover:text-slate-300 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — Connect Google Calendar */}
          {step === 3 && (
            <div className="text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
                style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(99,102,241,0.25))', border: '1px solid rgba(96,165,250,0.3)' }}
              >
                <Calendar size={28} className="text-blue-400" />
              </div>
              <h1 className="text-xl font-bold text-white mb-2">Connect your Google Calendars</h1>
              <p className="text-slate-400 text-sm mb-8">
                See your real schedule and let the AI scan Gmail for appointments. Each family member connects their own account.
              </p>
              <button
                onClick={() => {
                  setCalendarRedirecting(true)
                  router.push(`/api/auth/google?email=${user?.email ?? ''}`)
                }}
                disabled={calendarRedirecting}
                className="w-full py-3 rounded-xl font-semibold text-white mb-3 transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
              >
                {calendarRedirecting ? 'Redirecting…' : 'Connect & Continue'}
              </button>
              {calendarRedirecting && (
                <p className="text-xs text-slate-400 mb-3">
                  You&apos;ll be redirected to Google, then brought back to the app.
                </p>
              )}
              <button
                onClick={() => setStep(4)}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-400 border border-white/10 hover:bg-white/5 transition-all"
              >
                Skip for now
              </button>
            </div>
          )}

          {/* Step 4 — Notifications */}
          {step === 4 && (
            <div className="text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
                style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(99,102,241,0.25))', border: '1px solid rgba(96,165,250,0.3)' }}
              >
                <Bell size={28} className="text-blue-400" />
              </div>
              <h1 className="text-xl font-bold text-white mb-2">Stay in the loop</h1>
              <p className="text-slate-400 text-sm mb-8">
                Get a daily morning agenda and reminders for events and chores right on your phone.
              </p>
              {notifSupported ? (
                <button
                  onClick={turnOnNotifications}
                  className="w-full py-3 rounded-xl font-semibold text-white mb-3 transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
                >
                  Enable Notifications
                </button>
              ) : (
                <div
                  className="rounded-xl p-4 mb-3 text-left border border-amber-400/20"
                  style={{ background: 'rgba(251,191,36,0.08)' }}
                >
                  <p className="text-xs text-amber-400 leading-relaxed">
                    To get push notifications on iPhone, first add this app to your Home Screen
                    (Share → Add to Home Screen), then open it and enable notifications from the dashboard.
                  </p>
                </div>
              )}
              <button
                onClick={() => setStep(5)}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-400 border border-white/10 hover:bg-white/5 transition-all"
              >
                Maybe later
              </button>
            </div>
          )}

          {/* Step 5 — Done */}
          {step === 5 && (
            <div className="text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
                style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.25), rgba(16,185,129,0.25))', border: '1px solid rgba(34,197,94,0.3)' }}
              >
                <PartyPopper size={28} className="text-green-400" />
              </div>
              <div className="text-4xl mb-3">🎉</div>
              <h1 className="text-2xl font-bold text-white mb-2">You&apos;re all set!</h1>
              <p className="text-slate-400 text-sm mb-8">
                Try the Capture button (+ in the corner) — just type &quot;dentist for Mia next Tuesday at 3pm&quot; and the AI will sort it out.
              </p>
              <button
                onClick={() => router.replace('/command')}
                className="w-full py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, #16a34a, #059669)' }}
              >
                Go to Dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
