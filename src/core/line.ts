// The one-line task format Simple Todo's agent inbox uses, so instructions written for it still
// work here:
//
//   - [ ] Text of the task !high @project-name #tag due:2026-01-31
//
// Markers are optional and may sit anywhere in the line: `!urgent`, `!high`, `!medium`, `!low`
// for priority, `@name` for the project, `#name` for tags, `due:YYYY-MM-DD` (or `due:today`,
// `due:tomorrow`, anything parseDay reads). orca-tasks adds `source:<text-without-spaces>`.
// `- [x]` adds the task already done. Since 0.3.0 a due may carry a time (`due:fri@15:30`,
// `due:2026-01-31T09:00`), and `!u`, `!h`, `!m`, `!l` are short for the priorities. Quick add in
// the panel and the board also reads `@today`, `@tomorrow`, `@tmr`, `@fri` and `@2026-01-31` as
// the due day (`dueWords`); the inbox and the CLI keep `@` for projects only.

import { DateInputError, parseDue } from './dates.ts'
import type { NewTask, Priority, Task } from './types.ts'

const LIST_MARKER = /^(?:[-*+]\s+)?(?:\[([ xX])\]\s+)?/
const PRIORITY_WORDS: Record<string, Priority> = {
  urgent: 'urgent',
  high: 'high',
  medium: 'medium',
  med: 'medium',
  low: 'low',
  none: 'none',
  u: 'urgent',
  h: 'high',
  m: 'medium',
  l: 'low'
}
const DUE_WORD_RE = /^(today|tod|tomorrow|tmr|tom|mon(day)?|tue(sday)?|tues|wed(nesday)?|thu(rsday)?|thur|thurs|fri(day)?|sat(urday)?|sun(day)?|\d{4}-\d{2}-\d{2})(@.+)?$/i
const TAG_RE = /^#([\p{L}\p{N}_\-/.]+)$/u
const PROJECT_RE = /^@([\p{L}\p{N}_\-/.]+)$/u

export interface ParsedLine extends NewTask {
  /** `- [x]` in the line. */
  done: boolean
}

export interface ParseOptions {
  /** Read `@today`, `@fri`, `@2026-01-31` (and `@fri@15:30`) as the due day, as quick add does. */
  dueWords?: boolean
}

/** One line read as a task, or null when it holds none (blank, a heading, a comment). */
export function parseLine(line: string, today: string, options: ParseOptions = {}): ParsedLine | null {
  let text = line.trim()
  if (text === '' || /^#{1,6}\s/.test(text) || text.startsWith('<!--')) return null
  const marker = LIST_MARKER.exec(text)
  const done = marker?.[1] === 'x' || marker?.[1] === 'X'
  text = text.slice(marker?.[0].length ?? 0)

  const words: string[] = []
  const tags: string[] = []
  let priority: Priority | undefined
  let project: string | undefined
  let due: string | null | undefined
  let dueTime: string | null | undefined
  let source: string | undefined
  for (const word of text.split(/\s+/)) {
    if (word === '') continue
    const lower = word.toLowerCase()
    if (lower.startsWith('!') && PRIORITY_WORDS[lower.slice(1)]) {
      priority = PRIORITY_WORDS[lower.slice(1)]
      continue
    }
    const tag = TAG_RE.exec(word)
    if (tag) {
      if (!tags.includes(tag[1])) tags.push(tag[1])
      continue
    }
    if (options.dueWords && word.startsWith('@') && DUE_WORD_RE.test(word.slice(1))) {
      try {
        const parsed = parseDue(word.slice(1), today)
        due = parsed.day
        dueTime = parsed.time
        continue
      } catch (error) {
        if (!(error instanceof DateInputError)) throw error
      }
    }
    const proj = PROJECT_RE.exec(word)
    if (proj) {
      project = proj[1]
      continue
    }
    if (lower.startsWith('due:') && word.length > 4) {
      try {
        const parsed = parseDue(word.slice(4), today)
        due = parsed.day
        dueTime = parsed.time
        continue
      } catch (error) {
        if (!(error instanceof DateInputError)) throw error
        // Not a day after all: keep it as part of the title.
      }
    }
    if (lower.startsWith('source:') && word.length > 7) {
      source = word.slice(7)
      continue
    }
    words.push(word)
  }
  const title = words.join(' ')
  if (title === '') return null
  const parsed: ParsedLine = { title, done, tags }
  if (priority) parsed.priority = priority
  if (project !== undefined) parsed.project = project
  if (due !== undefined) parsed.due = due
  if (dueTime) parsed.due_time = dueTime
  if (source !== undefined) parsed.source = source
  return parsed
}

/** Every task in a block of text, one per line. */
export function parseLines(text: string, today: string, options: ParseOptions = {}): ParsedLine[] {
  const out: ParsedLine[] = []
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line, today, options)
    if (parsed) out.push(parsed)
  }
  return out
}

/** A task written back in the same format (notes are left out: the format is one line). */
export function formatLine(task: Task): string {
  const parts = [`- [${task.done_at ? 'x' : ' '}]`, task.title]
  if (task.priority !== 'none') parts.push(`!${task.priority}`)
  if (task.project) parts.push(`@${task.project.replace(/\s+/g, '-')}`)
  for (const tag of task.tags) parts.push(`#${tag.replace(/\s+/g, '-')}`)
  if (task.due) parts.push(`due:${task.due}${task.due_time ? `@${task.due_time}` : ''}`)
  if (task.source && !/\s/.test(task.source)) parts.push(`source:${task.source}`)
  return parts.join(' ')
}
