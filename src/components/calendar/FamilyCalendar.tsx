'use client'

import { useState, useCallback } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { DateClickArg } from '@fullcalendar/interaction'
import type { EventClickArg } from '@fullcalendar/core'
import { Plus } from 'lucide-react'
import { useCalendarEvents } from '@/hooks/useCalendarEvents'
import { useSheetsData } from '@/hooks/useSheetsData'
import { MemberLegend } from './MemberLegend'
import { EventModal } from './EventModal'
import { Button } from '@/components/ui/button'
import type { CalendarEvent, FamilyMember } from '@/lib/types'

export function FamilyCalendar() {
  const { events, create, update, remove } = useCalendarEvents()
  const { data: members } = useSheetsData<FamilyMember>('family')

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string>()
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent>()

  const fcEvents = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.isAllDay,
    backgroundColor: e.color,
    borderColor: e.color,
    textColor: '#fff',
    extendedProps: e,
  }))

  const handleDateClick = useCallback((info: DateClickArg) => {
    setSelectedDate(info.dateStr)
    setSelectedEvent(undefined)
    setModalOpen(true)
  }, [])

  const handleEventClick = useCallback((info: EventClickArg) => {
    setSelectedEvent(info.event.extendedProps as CalendarEvent)
    setSelectedDate(undefined)
    setModalOpen(true)
  }, [])

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-900">Calendar</h1>
        <Button size="sm" onClick={() => { setSelectedEvent(undefined); setSelectedDate(undefined); setModalOpen(true) }}>
          <Plus size={16} className="mr-1" /> Add Event
        </Button>
      </div>

      <MemberLegend members={members} />

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek',
          }}
          events={fcEvents}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
          height="auto"
          eventDisplay="block"
          dayMaxEventRows={3}
        />
      </div>

      <EventModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initialDate={selectedDate}
        event={selectedEvent}
        onCreate={create}
        onUpdate={
          selectedEvent
            ? (updates) => update(selectedEvent.id, selectedEvent.calendarId, updates)
            : undefined
        }
        onDelete={
          selectedEvent
            ? () => remove(selectedEvent.id, selectedEvent.calendarId)
            : undefined
        }
      />
    </div>
  )
}
