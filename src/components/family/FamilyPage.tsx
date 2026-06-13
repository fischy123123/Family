'use client'

import { useState } from 'react'
import { Plus, BookMarked, Users } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { MemberCard } from './MemberCard'
import { MemberForm } from './MemberForm'
import { TemplateForm } from './TemplateForm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { FamilyMember, Template } from '@/lib/types'

type Tab = 'members' | 'templates'

export function FamilyPage() {
  const [tab, setTab] = useState<Tab>('members')
  const [memberFormOpen, setMemberFormOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<FamilyMember>()
  const [templateFormOpen, setTemplateFormOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template>()

  const members = useFirestore<FamilyMember>('members')
  const templates = useFirestore<Template>('templates')
  const { inviteCode } = useFamily()

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Family</h1>
        <Button
          size="sm"
          onClick={() => {
            if (tab === 'members') { setEditingMember(undefined); setMemberFormOpen(true) }
            else { setEditingTemplate(undefined); setTemplateFormOpen(true) }
          }}
        >
          <Plus size={16} className="mr-1" /> Add {tab === 'members' ? 'Member' : 'Template'}
        </Button>
      </div>

      {inviteCode && (
        <div className="mb-6 p-4 bg-blue-50 rounded-xl border border-blue-100">
          <p className="text-xs text-blue-500 font-medium uppercase tracking-wider mb-1">Family Invite Code</p>
          <p className="text-2xl font-mono font-bold text-blue-700 tracking-widest">{inviteCode}</p>
          <p className="text-xs text-blue-400 mt-1">Share this code with family members so they can join</p>
        </div>
      )}

      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl">
        {([['members', 'Members', Users], ['templates', 'Templates', BookMarked]] as const).map(([t, label, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {members.data.map((m) => (
            <MemberCard
              key={m.id}
              member={m}
              onEdit={() => { setEditingMember(m); setMemberFormOpen(true) }}
            />
          ))}
          {members.data.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400">
              <Users size={40} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Add your family members to get started</p>
            </div>
          )}
        </div>
      )}

      {tab === 'templates' && (
        <div className="space-y-2">
          {templates.data.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm"
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${t.colorHex}20` }}>
                <BookMarked size={16} style={{ color: t.colorHex }} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{t.name}</p>
                <p className="text-xs text-gray-400">{t.items.length} items · {t.kind}</p>
              </div>
              <Badge variant="secondary">{t.kind}</Badge>
              <Button size="sm" variant="ghost" onClick={() => { setEditingTemplate(t); setTemplateFormOpen(true) }}>
                Edit
              </Button>
            </div>
          ))}
          {templates.data.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <BookMarked size={40} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Create reusable templates for checklists and shopping lists</p>
            </div>
          )}
        </div>
      )}

      <MemberForm
        open={memberFormOpen}
        onClose={() => setMemberFormOpen(false)}
        member={editingMember}
        onSave={async (m) => {
          if (editingMember) await members.update(m)
          else await members.create(m)
        }}
      />

      <TemplateForm
        open={templateFormOpen}
        onClose={() => setTemplateFormOpen(false)}
        template={editingTemplate}
        onSave={async (t) => {
          if (editingTemplate) await templates.update(t)
          else await templates.create(t)
        }}
      />
    </div>
  )
}
