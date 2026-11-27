// Checklists in a task's notes: every `- [ ] step` or `- [x] step` line is one item. Rows and
// cards show the progress ("2/5"), and the details pane ticks items in place. Pure functions.

const ITEM_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/

export interface ChecklistItem {
  /** Which line of the notes it is on, from 0. */
  line: number
  text: string
  done: boolean
}

export interface Checklist {
  items: ChecklistItem[]
  done: number
  total: number
}

/** The checklist items in `notes`, in order. */
export function checklist(notes: string): Checklist {
  const items: ChecklistItem[] = []
  notes.split('\n').forEach((line, index) => {
    const m = ITEM_RE.exec(line.replace(/\r$/, ''))
    if (m && m[4].trim() !== '') items.push({ line: index, text: m[4].trim(), done: m[2] !== ' ' })
  })
  return { items, done: items.filter((item) => item.done).length, total: items.length }
}

/** `notes` with the item on `line` ticked (or unticked); unchanged when that line is no item. */
export function setChecklistItem(notes: string, line: number, done: boolean): string {
  const lines = notes.split('\n')
  const m = ITEM_RE.exec(lines[line] ?? '')
  if (!m) return notes
  lines[line] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}`
  return lines.join('\n')
}

/** "2/5", or "" when the notes hold no checklist. */
export function checklistLabel(notes: string): string {
  const list = checklist(notes)
  return list.total === 0 ? '' : `${list.done}/${list.total}`
}
