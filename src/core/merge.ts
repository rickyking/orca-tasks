// Merging tasks: duplicates often come in from different places (a chat message and a meeting
// note asking for the same thing). One task is kept; the others are folded into it and stay,
// cancelled, pointing at it. Pure functions: the store runs `mergeTasks` under its lock, and the
// panel uses `mergeDefaults` to show what a merge will do before the person confirms it.
//
// The keeper keeps its title and status. From the merged tasks it gets:
// - their notes, each under a "Merged from <title> (<id>)" heading;
// - their sources and tags (each once);
// - their bot handoffs and project workspaces (history in time order);
// - the earliest created date, the earliest due day (with its time) and the highest priority,
//   unless the person chose otherwise.
// Each merged task moves to the first cancelled status (else the first done one) with
// `merged_into` set to the keeper, so `orca-tasks get <old id>` and `add --dedupe` find the keeper.

import { firstOfKind } from './statuses.ts'
import { patchTask, sourcesOf, TaskInputError } from './tasks.ts'
import { PRIORITIES, type Priority, type ProjectSend, type StatusDef, type Task } from './types.ts'

/** Which due day the keeper gets: the earliest of all, the keeper's own, none, or a day. */
export type DueChoice = 'earliest' | 'keep' | 'none' | { due: string; due_time: string | null }
/** Which priority: the highest of all, the keeper's own, or one. */
export type PriorityChoice = 'highest' | 'keep' | Priority
/** Which created date: the earliest of all, or the keeper's own. */
export type CreatedChoice = 'earliest' | 'keep'

export interface MergeChoices {
  due?: DueChoice
  priority?: PriorityChoice
  created?: CreatedChoice
}

export interface MergePlan {
  /** The keeper as it will be. */
  keeper: Task
  /** The merged tasks as they will be (cancelled, `merged_into` the keeper). */
  merged: Task[]
}

const RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/** The highest priority among tasks. */
export function highestPriority(tasks: readonly Task[]): Priority {
  return tasks.map((t) => t.priority).sort((a, b) => RANK[a] - RANK[b])[0] ?? 'none'
}

/** The earliest due day among tasks, with its time (the earliest time on that day), or null. */
export function earliestDue(tasks: readonly Task[]): { due: string; due_time: string | null } | null {
  const due = tasks
    .filter((t) => t.due !== null)
    .sort((a, b) => (a.due as string).localeCompare(b.due as string) || (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99'))[0]
  return due ? { due: due.due as string, due_time: due.due_time } : null
}

/** The earliest created date among tasks. */
export function earliestCreated(tasks: readonly Task[]): string {
  return tasks.map((t) => t.created_at).sort()[0]
}

/** What a merge does with nothing chosen: the values the confirm step starts from. */
export function mergeDefaults(keeper: Task, others: readonly Task[]): { due: { due: string; due_time: string | null } | null; priority: Priority; created_at: string } {
  const all = [keeper, ...others]
  return { due: earliestDue(all), priority: highestPriority(all), created_at: earliestCreated(all) }
}

/** Why these tasks cannot be merged, or null. */
export function mergeProblem(keeper: Task, others: readonly Task[]): string | null {
  if (others.length === 0) return 'choose at least one other task to merge into it'
  if (keeper.merged_into) return `${keeper.id} was itself merged into ${keeper.merged_into}; merge into that one instead`
  const ids = new Set<string>()
  for (const t of others) {
    if (t.id === keeper.id) return `${t.id} cannot be merged into itself`
    if (ids.has(t.id)) return `${t.id} is listed twice`
    ids.add(t.id)
    if (t.merged_into) return `${t.id} was already merged into ${t.merged_into}`
  }
  return null
}

function sortedBySentAt<T extends { sent_at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.sent_at.localeCompare(b.sent_at))
}

/** The notes of the keeper with each merged task's notes under its own heading. */
export function mergedNotes(keeper: Task, others: readonly Task[]): string {
  const parts = keeper.notes.trim() === '' ? [] : [keeper.notes.replace(/\s+$/, '')]
  for (const t of others) {
    const extra: string[] = []
    if (t.source) extra.push(`Source: ${t.source}`)
    if (t.notes.trim() !== '') extra.push(t.notes.trim())
    parts.push([`## Merged from ${t.title} (${t.id})`, ...extra].join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * The keeper and the merged tasks after merging `others` into `keeper` (see the top of this
 * file). Throws TaskInputError when they cannot be merged.
 */
export function mergeTasks(keeper: Task, others: readonly Task[], choices: MergeChoices, now: Date, statuses: readonly StatusDef[]): MergePlan {
  const problem = mergeProblem(keeper, others)
  if (problem) throw new TaskInputError(problem)
  const at = now.toISOString()
  const all = [keeper, ...others]
  const dueChoice = choices.due ?? 'earliest'
  const due = dueChoice === 'earliest' ? earliestDue(all) : dueChoice === 'keep' ? (keeper.due ? { due: keeper.due, due_time: keeper.due_time } : null) : dueChoice === 'none' ? null : dueChoice
  const priorityChoice = choices.priority ?? 'highest'
  if (priorityChoice !== 'highest' && priorityChoice !== 'keep' && !(PRIORITIES as readonly string[]).includes(priorityChoice)) {
    throw new TaskInputError(`priority must be highest, keep or one of ${PRIORITIES.join(', ')}`)
  }
  const priority = priorityChoice === 'highest' ? highestPriority(all) : priorityChoice === 'keep' ? keeper.priority : priorityChoice
  const created = (choices.created ?? 'earliest') === 'earliest' ? earliestCreated(all) : keeper.created_at
  const tags = [...new Set(all.flatMap((t) => t.tags))]
  const sources = [...new Set(all.flatMap((t) => sourcesOf(t)))]
  // Title and status stay; patchTask checks the fields and keeps the status fields consistent.
  const patched = patchTask(keeper, { notes: mergedNotes(keeper, others), due: due?.due ?? null, due_time: due?.due_time ?? null, priority, tags, source: keeper.source ?? sources[0] ?? null }, now, [], statuses)
  const workspaces = sortedBySentAt(all.flatMap((t) => t.workspaces ?? []) as ProjectSend[])
  const merged: Task = {
    ...patched,
    created_at: created,
    handoffs: sortedBySentAt(all.flatMap((t) => t.handoffs)),
    ...(workspaces.length ? { workspaces } : {}),
    ...(sources.length > 1 ? { sources } : {}),
    merged_from: [...(keeper.merged_from ?? []), ...others.map((t) => t.id)],
    updated_at: at
  }
  const cancelled = statuses.find((s) => s.kind === 'cancelled') ?? firstOfKind(statuses, 'done')
  const folded = others.map((t) => ({ ...patchTask(t, { state: cancelled.id }, now, [], statuses), merged_into: keeper.id, merged_at: at }))
  return { keeper: merged, merged: folded }
}

/** The task a merged task now lives in: follows `merged_into` (a keeper merged later too), or the
 *  task itself. */
export function keeperOf(tasks: readonly Task[], task: Task): Task {
  let current = task
  const seen = new Set<string>([task.id])
  while (current.merged_into) {
    const next = tasks.find((t) => t.id === current.merged_into)
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    current = next
  }
  return current
}
