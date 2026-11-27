// The keys of the sidebar and the board: what a key press does, given where the focus is and what
// is open. These are the page's own keys (a keydown listener in the panel's frame), not Orca
// keybindings, so they work only while the panel or the board has the focus and need no access.
// Pure functions, so the rules are tested without a browser (keys.test.ts).

/** Where the key was pressed. */
export type KeyTarget =
  /** A text field, a select, a checkbox or a date: typing there is never a shortcut. */
  | 'field'
  /** A button: Enter and Space press it, as usual. */
  | 'button'
  /** A task's row or card (it has the focus). */
  | 'task'
  /** Anywhere else (the page itself). */
  | 'page'

/** Which field has the focus, when `target` is `field`. */
export type FieldPlace =
  /** Quick add or search: what was typed stays in the box. */
  | 'box'
  /** A field of the details pane (title, notes, tags…): it saves when left. */
  | 'details'
  /** A field of a send form (the instruction for the bot or the agent). */
  | 'form'
  /** Anything else (Statuses). */
  | 'other'

export interface KeyPress {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  target: KeyTarget
  field?: FieldPlace
}

/** What is open, from the top down. */
export interface KeyScreen {
  sidebar: boolean
  /** A status menu (it handles its own keys first). */
  menu: boolean
  /** The shortcuts list. */
  help: boolean
  /** A send form or the merge confirm step. */
  form: 'send' | 'project' | 'merge' | null
  /** The merge suggestions (Suggest merges) are shown. */
  suggestions: boolean
  /** The open send form has an instruction typed in it that has not been sent. */
  draft: boolean
  /** Esc was pressed once on that draft already: the next Esc discards it. */
  armed: boolean
  /** A task's details are shown. */
  details: boolean
  /** Statuses is shown in place of the tasks. */
  settings: boolean
  /** Tasks are picked for a merge. */
  picked: boolean
}

export type KeyAction =
  | 'none'
  | 'close-menu'
  | 'close-help'
  /** Esc on a send form with a typed instruction: say that the next Esc discards it. */
  | 'warn-draft'
  | 'close-form'
  | 'close-suggestions'
  | 'close-details'
  | 'close-settings'
  | 'clear-picked'
  | 'next'
  | 'previous'
  | 'open'
  | 'toggle-done'
  /** P: to the first on-hold status (Pending), or off hold again. */
  | 'pending'
  /** C: to the first cancelled status, or reopened again. */
  | 'cancel'
  | 'quick-add'
  | 'search'
  | 'toggle-view'
  | 'help'
  /** Cmd/Ctrl+Enter in a details field: save it (leave the field), the pane stays. */
  | 'save'
  /** Cmd/Ctrl+Enter in a send form: send it. */
  | 'submit'
  /** The mouse's back button or the Browser Back key: close what is on top, else the view before
   *  (history.ts decides which). */
  | 'back'
  | 'forward'
  /** Back and Forward through the views shown (filter, project, list or board). */
  | 'view-back'
  | 'view-forward'

export interface KeyResult {
  /** Leave the focused field first (a details field saves when it is left). */
  leave: boolean
  action: KeyAction
}

const NOTHING: KeyResult = { leave: false, action: 'none' }

/** What Esc closes, from the top down: the status menu, the shortcuts, a form (asking once when an
 *  instruction was typed in it), the merge suggestions, the details, Statuses, then the picked
 *  tasks. */
export function escape(screen: KeyScreen): KeyAction {
  if (screen.menu) return 'close-menu'
  if (screen.help) return 'close-help'
  if (screen.form) return screen.draft && !screen.armed ? 'warn-draft' : 'close-form'
  if (screen.suggestions) return 'close-suggestions'
  if (screen.details) return 'close-details'
  if (screen.settings) return 'close-settings'
  if (screen.picked) return 'clear-picked'
  return 'none'
}

/** What the key press `press` does on `screen`. */
export function keyAction(press: KeyPress, screen: KeyScreen): KeyResult {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key
  const mod = press.meta || press.ctrl
  // Browser Back / Forward (a mouse's thumb buttons on some setups, media keyboards): a step back
  // or forward in the page, also from a field (a details field saves as it is left).
  if (key === 'BrowserBack' || key === 'BrowserForward') return { leave: press.target === 'field', action: key === 'BrowserBack' ? 'back' : 'forward' }
  if (press.target === 'field') {
    if (key === 'Escape') {
      // Quick add, search, Statuses: leave the box; what was typed stays. A send form's
      // instruction: Esc asks once before it is discarded. A details field saves as it is left,
      // and Esc goes on to close what is open.
      if (press.field === 'box' || press.field === 'other') return { leave: true, action: 'none' }
      return { leave: true, action: escape(screen) }
    }
    if (key === 'Enter' && mod && !press.alt) {
      if (press.field === 'details') return { leave: true, action: 'save' }
      if (press.field === 'form') return { leave: false, action: 'submit' }
    }
    // Everything else is typing.
    return NOTHING
  }
  if (key === 'Escape') return { leave: false, action: escape(screen) }
  if (mod || press.alt) return NOTHING
  // A focused button takes Enter and Space itself.
  if (press.target === 'button' && (key === 'Enter' || key === ' ')) return NOTHING
  // The menu has its own keys; the others wait until it is closed.
  if (screen.menu) return NOTHING
  switch (key) {
    case '?':
      return { leave: false, action: 'help' }
    case 'j':
    case 'ArrowDown':
      return press.shift ? NOTHING : { leave: false, action: 'next' }
    case 'k':
    case 'ArrowUp':
      return press.shift ? NOTHING : { leave: false, action: 'previous' }
    case 'Enter':
      return { leave: false, action: 'open' }
    case 'x':
    case ' ':
      return press.shift ? NOTHING : { leave: false, action: 'toggle-done' }
    case 'p':
      return press.shift ? NOTHING : { leave: false, action: 'pending' }
    case 'c':
      return press.shift ? NOTHING : { leave: false, action: 'cancel' }
    case 'n':
      return press.shift ? NOTHING : { leave: false, action: 'quick-add' }
    case '/':
      // The sidebar has no search box: / goes to quick add there.
      return { leave: false, action: screen.sidebar ? 'quick-add' : 'search' }
    case 'v':
      return press.shift || screen.sidebar ? NOTHING : { leave: false, action: 'toggle-view' }
    default:
      return NOTHING
  }
}

/** The task the cursor moves to: the next or the previous in `order` from `from` (the first or
 *  the last when `from` is not shown), staying at the ends. */
export function moveCursor(order: readonly string[], from: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null
  const at = from === null ? -1 : order.indexOf(from)
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1]
  return order[Math.max(0, Math.min(order.length - 1, at + step))]
}

/** The shortcuts, as the ? list and the README show them. */
export function shortcutList(sidebar: boolean): [string, string][] {
  return [
    ['↑ ↓  or  J K', 'Move between tasks (the open details follow)'],
    ['Enter', 'Open the task'],
    ['X  or  Space', 'Done, or reopen'],
    ['P', 'Pending (your first on-hold status), or off hold again'],
    ['C', 'Cancelled (your first cancelled status), or reopen'],
    [sidebar ? 'N  or  /' : 'N', 'Add a task (quick add)'],
    ...(sidebar ? [] : ([['/', 'Search'], ['V', 'List or board']] as [string, string][])),
    ['Cmd/Ctrl+Enter', 'Save the field (notes, title); in a send form, send'],
    ['Esc', 'Close the menu, the form, the merge suggestions, the details, Statuses; clear the picked tasks. In a field: leave it (details fields save)'],
    ['Mouse back button', 'Back: close the menu, the form, the details, Statuses, as Esc does; then the view before (Show, project' + (sidebar ? '' : ', list or board') + ')'],
    ['Mouse forward button', 'Forward again: the view, or the task Back closed'],
    ['?', 'Show or hide these shortcuts']
  ]
}
