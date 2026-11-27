// The person's task statuses: the file's `statuses`, in the order the sidebar's sections and the
// board's columns show them. Each has a kind (open, on hold, done, cancelled) that says what it
// means for the fields older readers know (`status`, `done_at`, `held_at`). Pure functions.

import { STATUS_COLORS, STATUS_KINDS, type StatusColor, type StatusDef, type StatusKind } from './types.ts'

export class StatusError extends Error {
  readonly code = 'invalid_params'
}

/** The statuses a list starts with, and that a file written before 0.4.0 gets. */
export const DEFAULT_STATUSES: readonly StatusDef[] = [
  { id: 'todo', name: 'To Do', color: 'gray', kind: 'open', closed: false },
  { id: 'in-progress', name: 'In Progress', color: 'blue', kind: 'open', closed: false },
  { id: 'pending', name: 'Pending', color: 'amber', kind: 'hold', closed: false },
  { id: 'done', name: 'Done', color: 'green', kind: 'done', closed: true },
  { id: 'cancelled', name: 'Cancelled', color: 'red', kind: 'cancelled', closed: true }
]

/** Every list keeps at least one status of each of these kinds, so `orca-tasks hold`, `unhold`,
 *  `done` and `undone` always have somewhere to put a task. */
export const REQUIRED_KINDS: readonly StatusKind[] = ['open', 'hold', 'done']

export const KIND_LABELS: Record<StatusKind, string> = {
  open: 'Open',
  hold: 'Open · on hold',
  done: 'Closed · done',
  cancelled: 'Closed · cancelled'
}

export function isClosedKind(kind: StatusKind): boolean {
  return kind === 'done' || kind === 'cancelled'
}

/** The `status` older readers see for a status of this kind. */
export function legacyStatus(kind: StatusKind): 'open' | 'hold' | 'done' {
  return kind === 'hold' ? 'hold' : isClosedKind(kind) ? 'done' : 'open'
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** An id for a new status named `name`, not among `taken`. */
export function statusId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'status'
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new StatusError('a status name must be text')
  const name = value.replace(/\s+/g, ' ').trim()
  if (name === '') throw new StatusError('a status name cannot be empty')
  if (name.length > 60) throw new StatusError('a status name is at most 60 characters')
  return name
}

function cleanColor(value: unknown): StatusColor {
  if (typeof value === 'string' && (STATUS_COLORS as readonly string[]).includes(value)) return value as StatusColor
  throw new StatusError(`the colour must be one of ${STATUS_COLORS.join(', ')}`)
}

function cleanKind(value: unknown): StatusKind {
  if (typeof value === 'string' && (STATUS_KINDS as readonly string[]).includes(value)) return value as StatusKind
  throw new StatusError(`the kind must be one of ${STATUS_KINDS.join(', ')}`)
}

/**
 * The statuses a file holds, repaired enough to work with: bad entries dropped, duplicate ids and
 * names dropped, and a default one put back for each required kind that has none. Missing or empty:
 * the defaults. Unknown fields on an entry are kept.
 */
export function normalizeStatuses(raw: unknown): StatusDef[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_STATUSES.map((s) => ({ ...s }))
  const out: StatusDef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id) || typeof s.name !== 'string' || s.name.trim() === '') continue
    if (out.some((o) => o.id === s.id || squash(o.name) === squash(s.name as string))) continue
    const kind = (STATUS_KINDS as readonly unknown[]).includes(s.kind) ? (s.kind as StatusKind) : s.closed === true ? 'done' : 'open'
    const color = (STATUS_COLORS as readonly unknown[]).includes(s.color) ? (s.color as StatusColor) : 'gray'
    out.push({ ...s, id: s.id, name: s.name.replace(/\s+/g, ' ').trim(), color, kind, closed: isClosedKind(kind) })
  }
  for (const kind of REQUIRED_KINDS) {
    if (out.some((s) => s.kind === kind)) continue
    const fallback = DEFAULT_STATUSES.find((s) => s.kind === kind) as StatusDef
    const taken = new Set(out.map((s) => s.id))
    const name = out.some((s) => squash(s.name) === squash(fallback.name)) ? `${fallback.name} (${kind})` : fallback.name
    out.push({ ...fallback, id: taken.has(fallback.id) ? statusId(fallback.id, taken) : fallback.id, name })
  }
  return out
}

/** The first status of a kind, in the person's order: where a task goes when it is completed,
 *  put on hold or reopened without a status being named. */
export function firstOfKind(statuses: readonly StatusDef[], kind: StatusKind): StatusDef {
  const found = statuses.find((s) => s.kind === kind)
  if (found) return found
  if (kind === 'cancelled') return firstOfKind(statuses, 'done')
  // normalizeStatuses always keeps the required kinds; this is for hand-made lists in tests.
  return DEFAULT_STATUSES.find((s) => s.kind === kind) as StatusDef
}

/** The status a person or agent named: its id, else its name in any case or spacing. */
export function findStatus(statuses: readonly StatusDef[], text: string): StatusDef | null {
  const typed = text.trim()
  if (typed === '') return null
  const exact = statuses.find((s) => s.id === typed || s.name === typed)
  if (exact) return exact
  const lower = typed.toLowerCase()
  const caseless = statuses.find((s) => s.id === lower || s.name.toLowerCase() === lower)
  if (caseless) return caseless
  const key = squash(typed)
  const loose = statuses.filter((s) => squash(s.name) === key || squash(s.id) === key)
  return loose.length === 1 ? loose[0] : null
}

/** Where a task goes when it is sent to a bot or to its project and nothing else was chosen: the
 *  open status named "In Progress" (any case or spacing), else the one that started as In
 *  Progress (id `in-progress`, renamed since) while it is open. Null when there is neither (the
 *  person deleted it): the status is then left as it is. */
export function defaultSendStatus(statuses: readonly StatusDef[]): StatusDef | null {
  const open = statuses.filter((s) => !s.closed)
  return open.find((s) => squash(s.name) === 'inprogress') ?? open.find((s) => s.id === 'in-progress') ?? null
}

export function resolveStatus(statuses: readonly StatusDef[], text: string): StatusDef {
  const found = findStatus(statuses, text)
  if (!found) throw new StatusError(`no status "${text}"; the statuses are ${statuses.map((s) => s.name).join(', ')}`)
  return found
}

/** One change to the list of statuses, as the panel, the board and `orca-tasks statuses` make it. */
export type StatusOp =
  | { op: 'add'; name: string; kind?: StatusKind; color?: StatusColor; index?: number }
  | { op: 'update'; id: string; name?: string; kind?: StatusKind; color?: StatusColor }
  | { op: 'move'; id: string; index: number }
  /** Tasks in it move to `moveTo` (an id), else to the first other status of the same kind, else
   *  the first open one. */
  | { op: 'remove'; id: string; moveTo?: string }

export interface StatusChange {
  statuses: StatusDef[]
  /** Tasks in the status with the key move to the status with the value (ids). */
  moves: Record<string, string>
}

function checkKinds(list: readonly StatusDef[], what: string): void {
  for (const kind of REQUIRED_KINDS) {
    if (!list.some((s) => s.kind === kind)) throw new StatusError(`${what} would leave no ${KIND_LABELS[kind].toLowerCase()} status; keep at least one`)
  }
}

function checkName(list: readonly StatusDef[], name: string, self: string | null): void {
  if (list.some((s) => s.id !== self && squash(s.name) === squash(name))) throw new StatusError(`there is already a status called ${name}`)
}

/** The list after one change, checked: names stay unique and every required kind keeps a status. */
export function applyStatusOp(current: readonly StatusDef[], op: StatusOp): StatusChange {
  const list = current.map((s) => ({ ...s }))
  const index = (id: string) => {
    const at = list.findIndex((s) => s.id === id)
    if (at === -1) throw new StatusError(`no status with id ${id}`)
    return at
  }
  const clampIndex = (n: number | undefined, length: number) => (n === undefined || !Number.isFinite(n) ? length : Math.max(0, Math.min(length, Math.trunc(n))))
  switch (op.op) {
    case 'add': {
      const name = cleanName(op.name)
      checkName(list, name, null)
      const kind = op.kind === undefined ? 'open' : cleanKind(op.kind)
      const color = op.color === undefined ? 'gray' : cleanColor(op.color)
      const def: StatusDef = { id: statusId(name, new Set(list.map((s) => s.id))), name, color, kind, closed: isClosedKind(kind) }
      list.splice(clampIndex(op.index, list.length), 0, def)
      return { statuses: list, moves: {} }
    }
    case 'update': {
      const at = index(op.id)
      const next = { ...list[at] }
      if (op.name !== undefined) {
        next.name = cleanName(op.name)
        checkName(list, next.name, next.id)
      }
      if (op.color !== undefined) next.color = cleanColor(op.color)
      if (op.kind !== undefined) {
        next.kind = cleanKind(op.kind)
        next.closed = isClosedKind(next.kind)
      }
      list[at] = next
      checkKinds(list, `Making ${next.name} ${KIND_LABELS[next.kind].toLowerCase()}`)
      return { statuses: list, moves: {} }
    }
    case 'move': {
      const at = index(op.id)
      const [def] = list.splice(at, 1)
      list.splice(clampIndex(op.index, list.length), 0, def)
      return { statuses: list, moves: {} }
    }
    case 'remove': {
      const at = index(op.id)
      const [gone] = list.splice(at, 1)
      checkKinds(list, `Deleting ${gone.name}`)
      let target: StatusDef | undefined
      if (op.moveTo !== undefined) {
        target = list.find((s) => s.id === op.moveTo)
        if (!target) throw new StatusError(`no status with id ${op.moveTo} to move its tasks to`)
      } else {
        target = list.find((s) => s.kind === gone.kind) ?? firstOfKind(list, 'open')
      }
      return { statuses: list, moves: { [gone.id]: target.id } }
    }
  }
}
