// The quick actions a task's row or card shows on hover (and on keyboard focus): one small icon
// per status the task can move to, in the person's own order, and "…" for the rest and the other
// actions. Pure, tested in quick.test.ts.

import type { StatusDef } from '../core/types.ts'

/** The icon a status gets: ✓ done, a clock on hold, ✕ cancelled, ▶ In Progress, ○ another open one. */
export type QuickIcon = 'check' | 'clock' | 'close' | 'play' | 'circle'

export function quickIcon(def: StatusDef, inProgress: string | null): QuickIcon {
  if (def.kind === 'done') return 'check'
  if (def.kind === 'hold') return 'clock'
  if (def.kind === 'cancelled') return 'close'
  return def.id === inProgress ? 'play' : 'circle'
}

/** How many status icons fit: a sidebar row, a card, or a row of the board's list. */
export const QUICK_ROOM = { sidebar: 4, card: 3, list: 6 } as const

/**
 * The statuses a task in `current` gets as icons, at most `room`, in the person's order, and the
 * ones left for the "…" menu. When they do not all fit, the first done, on-hold and cancelled
 * statuses (Done, Pending, Cancelled) come first, then the others in order.
 */
export function quickStatuses(statuses: readonly StatusDef[], current: string, room: number): { shown: StatusDef[]; more: StatusDef[] } {
  const others = statuses.filter((s) => s.id !== current)
  if (others.length <= room) return { shown: others, more: [] }
  const first = (kind: StatusDef['kind']) => others.find((s) => s.kind === kind)
  const wanted = [first('done'), first('hold'), first('cancelled'), ...others].filter((s): s is StatusDef => s !== undefined)
  const picked = new Set<string>()
  for (const s of wanted) if (picked.size < room) picked.add(s.id)
  return { shown: others.filter((s) => picked.has(s.id)), more: others.filter((s) => !picked.has(s.id)) }
}

/** Where a status key (P for on hold, C for cancelled) moves a task in `current`: the first status
 *  of that kind, or back to the first open one when the task is already of that kind; null when
 *  the person has no status of that kind. */
export function keyTarget(statuses: readonly StatusDef[], current: string, kind: 'hold' | 'cancelled'): StatusDef | null {
  const now = statuses.find((s) => s.id === current)
  if (now?.kind === kind) return statuses.find((s) => s.kind === 'open') ?? null
  return statuses.find((s) => s.kind === kind) ?? null
}
