// The mouse's back and forward buttons (and the Browser Back / Forward keys, and Cmd+[ / Cmd+]
// and Cmd+Left / Cmd+Right, which mouse software on macOS sends for them) in the sidebar and on
// the board. "Back" means the view before, not the page before: it closes what is on top (the
// menu, the shortcuts, a form, the open task, Statuses, the picked tasks, as Esc does), then goes
// back through the views shown before (the filter, the project, list or board). The page keeps
// that history itself; it never adds entries to the frame's browser history, so Orca's own back
// and forward are unchanged and the frame is never navigated away. Pure, tested in history.test.ts.

import { escape, type KeyAction, type KeyScreen } from './keys.ts'

/** The thumb buttons, as `MouseEvent.button` numbers them (an MX Master's back is 3). */
export const MOUSE_BACK = 3
export const MOUSE_FORWARD = 4

/** What is shown: the list or board, the Show filter, the project, and the open task. */
export interface View {
  view: string
  filter: string
  project: string
  selected: string | null
}

/** How many views back are kept. */
const KEEP = 50

function sameList(a: View, b: View): boolean {
  return a.view === b.view && a.filter === b.filter && a.project === b.project
}

/** The views shown before and after the one shown now, like a browser's back and forward. Opening
 *  another task is not a step of its own (J/K move the open details through the tasks); Back
 *  closes it, and Forward opens it again. */
export class ViewHistory {
  private past: View[] = []
  private future: View[] = []
  private now: View | null = null

  /** Records what is shown now; call it after every redraw. A change of list, filter or project
   *  is a step (and drops what Forward had). */
  note(view: View): void {
    const was = this.now
    this.now = { ...view }
    if (!was) return
    if (sameList(was, view)) {
      // Another task opened by hand: what Forward would reopen is not "forward" any more.
      if (view.selected && view.selected !== was.selected) this.future = []
      return
    }
    this.past.push(was)
    if (this.past.length > KEEP) this.past.shift()
    this.future = []
  }

  /** Starts over from `view` (the page restored what it shows from the worker). */
  reset(view: View): void {
    this.past = []
    this.future = []
    this.now = { ...view }
  }

  canGoBack(): boolean {
    return this.past.length > 0
  }

  canGoForward(): boolean {
    return this.future.length > 0
  }

  /** Back closed the open task: Forward opens it again. */
  closedTask(): void {
    if (!this.now?.selected) return
    this.future.push(this.now)
    this.now = { ...this.now, selected: null }
  }

  /** The view to show going back (with no task open), or null at the first one. */
  back(): View | null {
    const to = this.past.pop()
    if (!to || !this.now) return null
    this.future.push(this.now)
    this.now = { ...to, selected: null }
    return this.now
  }

  /** The view to show going forward, or null when there is none. */
  forward(): View | null {
    const to = this.future.pop()
    if (!to || !this.now) return null
    if (!sameList(this.now, to)) this.past.push({ ...this.now, selected: null })
    this.now = { ...to }
    return this.now
  }
}

/** What Back does on `screen`: what Esc would close, else the view before. */
export function backAction(screen: KeyScreen, canGoBack: boolean): KeyAction {
  const closing = escape(screen)
  if (closing !== 'none') return closing
  return canGoBack ? 'view-back' : 'none'
}

/** What Forward does: the view Back left, if any. */
export function forwardAction(screen: KeyScreen, canGoForward: boolean): KeyAction {
  // Forward does not reopen anything under an open menu or form.
  if (screen.menu || screen.help || screen.form) return 'none'
  return canGoForward ? 'view-forward' : 'none'
}

/** The events one press of a thumb button can arrive as, in this order. Chromium sends all five,
 *  but a frame does not always get all of them: a cancelled pointerdown drops the mousedown and
 *  mouseup after it, and some mice and drivers give only the pointer events or only auxclick. */
export const MOUSE_NAV_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'] as const

const RELEASES: ReadonlySet<string> = new Set(['pointerup', 'mouseup', 'auxclick'])
/** Release events this close to the step taken belong to the same press. */
const SAME_PRESS_MS = 400

/**
 * The back and forward buttons, from whichever of their events arrive. Every event of those
 * buttons is to be stopped (`prevent`), so the frame is never navigated; the step is taken once
 * per press, on the first release event that arrives (pointerup, mouseup or auxclick), as browsers
 * go back on release. A press event after a step starts the next press.
 */
export class MouseNav {
  private stepped = new Map<number, number>()

  /** What to do with event `type` of mouse button `button`, at `time` (ms, `event.timeStamp`). */
  event(type: string, button: number, time: number): { prevent: boolean; step: 'back' | 'forward' | null } {
    if (button !== MOUSE_BACK && button !== MOUSE_FORWARD) return { prevent: false, step: null }
    if (!RELEASES.has(type)) {
      // A press: the next release is a step of its own.
      this.stepped.delete(button)
      return { prevent: true, step: null }
    }
    const last = this.stepped.get(button)
    if (last !== undefined && time - last >= 0 && time - last < SAME_PRESS_MS) return { prevent: true, step: null }
    this.stepped.set(button, time)
    return { prevent: true, step: button === MOUSE_BACK ? 'back' : 'forward' }
  }
}
