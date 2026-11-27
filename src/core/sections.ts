// How the sidebar and the board sort tasks into sections (columns on the board), and the due
// filter and labels both use. Pure functions.
//
// Since 0.4.0 the sections are the person's statuses, in their order (To Do, In Progress,
// Pending, Done, Cancelled by default): a task is in the section of its `state`. Closed statuses
// start collapsed, and are left out when the due filter shows only open work.

import { addDays } from './dates.ts'
import { activeHandoff, compareTasks, currentStatus, isClosed, isOverdue } from './tasks.ts'
import type { StatusDef, Task } from './types.ts'

/** The part of a bot's chat state sections need. */
export interface BotState {
  state: string
}

/** The status (section) a task is in. */
export function sectionOf(task: Task, statuses: readonly StatusDef[]): string {
  return currentStatus(task, statuses).id
}

/** A section's tasks in the order the panel and the board show them: the ones never dragged into
 *  place first, by due day, priority and age (closed ones newest first), then the ones the person
 *  ordered, by their rank. */
export function orderSection(tasks: readonly Task[]): Task[] {
  const free = tasks.filter((t) => typeof t.rank !== 'number').sort(compareTasks)
  const ranked = tasks.filter((t) => typeof t.rank === 'number').sort((a, b) => (a.rank as number) - (b.rank as number) || compareTasks(a, b))
  return [...free, ...ranked]
}

/**
 * The new order of a section after `id` is dropped into it before the task `before` (null: at the
 * end), as the full list of the section's ids. `section` is the whole section (also tasks a filter
 * hides) in its order now; the dragged task may be in it already (reordering) or not (it came
 * from another section).
 */
export function dropOrder(section: readonly string[], id: string, before: string | null): string[] {
  const rest = section.filter((x) => x !== id)
  const at = before === null ? -1 : rest.indexOf(before)
  if (at === -1) return [...rest, id]
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The tasks of each status, in the order given; every status has a list, empty or not. */
export function bySection(tasks: readonly Task[], statuses: readonly StatusDef[]): Record<string, Task[]> {
  const out: Record<string, Task[]> = Object.fromEntries(statuses.map((s) => [s.id, [] as Task[]]))
  for (const task of tasks) out[sectionOf(task, statuses)]?.push(task)
  return out
}

/** The statuses shown as sections with a due filter on: closed ones only with All and Due today
 *  (which includes what was closed today). */
export function visibleStatuses(statuses: readonly StatusDef[], filter: DueFilter): StatusDef[] {
  return statuses.filter((s) => !s.closed || filter === 'all' || filter === 'today')
}

/** Whether a bot it was sent to has answered: its chat says it finished, waits or is blocked. */
export function botReplied(task: Task, bot?: BotState | null): boolean {
  const state = bot?.state
  return activeHandoff(task) !== null && (state === 'done' || state === 'waiting' || state === 'blocked')
}

export type DueFilter = 'all' | 'today' | 'overdue' | 'upcoming' | 'nodue'

export const DUE_FILTERS: readonly { id: DueFilter; title: string }[] = [
  { id: 'all', title: 'All' },
  { id: 'today', title: 'Due today' },
  { id: 'overdue', title: 'Overdue' },
  { id: 'upcoming', title: 'Upcoming' },
  { id: 'nodue', title: 'No due day' }
]

/** Whether a task passes the due filter. "Due today" includes overdue ones and what was finished
 *  today; the others hide done tasks. */
export function matchesDue(task: Task, filter: DueFilter, today: string, time: string, doneDay: string | null): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'today':
      return isClosed(task) ? doneDay === today : task.due !== null && task.due <= today
    case 'overdue':
      return isOverdue(task, today, time)
    case 'upcoming':
      return !isClosed(task) && task.due !== null && task.due > today
    case 'nodue':
      return !isClosed(task) && task.due === null
  }
}

/** A day as a person reads it: Today, Tomorrow, Yesterday, a weekday within the week, else a date. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === addDays(today, 1)) return 'Tomorrow'
  if (day === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d, 12)
  if (day > today && day <= addDays(today, 6)) return date.toLocaleDateString('en', { weekday: 'short' })
  const sameYear = y === Number(today.slice(0, 4))
  return date.toLocaleDateString('en', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** A task's due as a short label ("Today 15:30", "Fri", "Nov 30"), or "" without one. */
export function dueLabel(task: Pick<Task, 'due' | 'due_time'>, today: string): string {
  if (!task.due) return ''
  return `${dayLabel(task.due, today)}${task.due_time ? ` ${task.due_time}` : ''}`
}
