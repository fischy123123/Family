'use client'

import React from 'react'

// ---------------------------------------------------------------------------
// Lightweight markdown renderer (no external deps).
// Supports: ## / ### headings, "- " / "* " bullets, "1." numbered lists,
// **bold**, *italic*, `code`, and paragraphs. Designed for the warm, skimmable
// replies the Copilot produces — not a full CommonMark implementation.
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Tokenize on **bold**, *italic*, and `code`
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  const parts = text.split(regex)
  parts.forEach((part, i) => {
    if (!part) return
    const key = `${keyPrefix}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900">
          {part.slice(2, -2)}
        </strong>,
      )
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={key} className="px-1.5 py-0.5 rounded-md bg-slate-100 text-[13px] font-mono text-slate-700">
          {part.slice(1, -1)}
        </code>,
      )
    } else if (part.startsWith('*') && part.endsWith('*')) {
      nodes.push(
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>,
      )
    } else {
      nodes.push(<React.Fragment key={key}>{part}</React.Fragment>)
    }
  })
  return nodes
}

export function Markdown({ content }: { content: string }) {
  const lines = content.split('\n')
  const blocks: React.ReactNode[] = []
  let listBuffer: { ordered: boolean; items: string[] } | null = null
  let key = 0

  function flushList() {
    if (!listBuffer) return
    const { ordered, items } = listBuffer
    const cls = 'space-y-1 my-2 ml-1'
    if (ordered) {
      blocks.push(
        <ol key={`ol-${key++}`} className={cls}>
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[15px] text-slate-700 leading-relaxed">
              <span className="text-blue-500 font-semibold shrink-0">{i + 1}.</span>
              <span>{renderInline(it, `oli-${i}`)}</span>
            </li>
          ))}
        </ol>,
      )
    } else {
      blocks.push(
        <ul key={`ul-${key++}`} className={cls}>
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[15px] text-slate-700 leading-relaxed">
              <span className="text-blue-400 shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span>{renderInline(it, `uli-${i}`)}</span>
            </li>
          ))}
        </ul>,
      )
    }
    listBuffer = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushList()
      continue
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/)
    const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/)
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/)

    if (headingMatch) {
      flushList()
      const level = headingMatch[1].length
      const txt = headingMatch[2]
      const sizes = ['text-lg font-bold', 'text-base font-bold', 'text-sm font-semibold']
      blocks.push(
        <p key={`h-${key++}`} className={`${sizes[level - 1]} text-slate-900 mt-3 mb-1 first:mt-0`}>
          {renderInline(txt, `h-${key}`)}
        </p>,
      )
    } else if (bulletMatch) {
      if (!listBuffer || listBuffer.ordered) {
        flushList()
        listBuffer = { ordered: false, items: [] }
      }
      listBuffer.items.push(bulletMatch[1])
    } else if (orderedMatch) {
      if (!listBuffer || !listBuffer.ordered) {
        flushList()
        listBuffer = { ordered: true, items: [] }
      }
      listBuffer.items.push(orderedMatch[1])
    } else {
      flushList()
      blocks.push(
        <p key={`p-${key++}`} className="text-[15px] text-slate-700 leading-relaxed my-1.5 first:mt-0 last:mb-0">
          {renderInline(line, `p-${key}`)}
        </p>,
      )
    }
  }
  flushList()

  return <div className="space-y-0.5">{blocks}</div>
}
