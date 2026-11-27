// Dragging on the board with pointer events. The board is a custom editor, which Orca shows in an
// isolated frame (an Electron <webview>); HTML5 drag and drop (draggable, dragstart, dragover,
// drop) is not delivered reliably there, so a dragged card never landed. Pointer events are plain
// input and reach the frame like any click.
//
// A press becomes a drag only once the pointer has moved a few pixels, so a click on a row or a
// card still selects it; the click that follows a drag is swallowed. Escape cancels a drag.
//
// The helpers at the top are pure, so Node tests them; `pointerDrag` and `ghostOf` need a DOM.

/** How far (CSS pixels) the pointer moves before a press becomes a drag. */
export const DRAG_THRESHOLD = 5

/** Whether the pointer has moved far enough from where it was pressed to start a drag. */
export function pastThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return dx * dx + dy * dy >= threshold * threshold
}

/** Where an item dropped at `y` goes among rows (top to bottom, their top and bottom edges): the
 *  index of the row it lands before, or `rows.length` after the last. A row counts as above the
 *  pointer once the pointer is past its middle. */
export function insertionIndex(y: number, rows: readonly { top: number; bottom: number }[]): number {
  let index = 0
  for (const row of rows) {
    if (y >= (row.top + row.bottom) / 2) index += 1
    else break
  }
  return index
}

/** The position to move an item at `from` to, when it is dropped before the row at `before`
 *  (an insertionIndex). Taking it out first shifts the rows after it up by one. */
export function moveIndex(from: number, before: number): number {
  return before > from ? before - 1 : before
}

/** How fast to scroll (pixels per frame, negative towards `start`) with the pointer at `pos` in a
 *  scroll area from `start` to `end`: faster the closer it is to an edge, nothing outside the
 *  `edge` band. */
export function edgeScroll(pos: number, start: number, end: number, edge = 40, max = 18): number {
  if (end - start < edge * 3) return 0
  if (pos < start + edge && pos >= start - edge) return -Math.ceil(max * Math.min(1, (start + edge - pos) / edge))
  if (pos > end - edge && pos <= end + edge) return Math.ceil(max * Math.min(1, (pos - (end - edge)) / edge))
  return 0
}

/** Elements a press on which is meant for them, not a drag of the row they sit in. */
const CONTROLS = 'button, a, input, select, textarea, label, [contenteditable], .no-drag'

export interface PointerDragOptions {
  /** Whether a press on `target` (inside the element) may start a drag; by default anything but a
   *  control (a button, a link, a field). */
  canStart?: (target: Element) => boolean
  /** The press became a drag, with the pointer at x, y. */
  onStart: (x: number, y: number) => void
  onMove: (x: number, y: number) => void
  /** Released after dragging, at x, y. */
  onDrop: (x: number, y: number) => void
  /** Escape, or the system took the pointer away. */
  onCancel: () => void
}

/** Lets `el` be dragged with the mouse (or a pen, or a finger). */
export function pointerDrag(el: HTMLElement, options: PointerDragOptions): void {
  el.addEventListener('pointerdown', (down: PointerEvent) => {
    if (down.button !== 0 || !down.isPrimary) return
    const target = down.target as Element | null
    if (!target) return
    if (options.canStart ? !options.canStart(target) : target.closest(CONTROLS) !== null && target.closest(CONTROLS) !== el) return
    let active = false
    const finish = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('keydown', key, true)
      try {
        if (el.hasPointerCapture(down.pointerId)) el.releasePointerCapture(down.pointerId)
      } catch {
        // The element may be gone already.
      }
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return
      if (!active) {
        if (!pastThreshold(e.clientX - down.clientX, e.clientY - down.clientY)) return
        active = true
        try {
          el.setPointerCapture(down.pointerId)
        } catch {
          // Capture is a nicety: window listeners already follow the pointer.
        }
        window.getSelection()?.removeAllRanges()
        options.onStart(e.clientX, e.clientY)
      }
      e.preventDefault()
      options.onMove(e.clientX, e.clientY)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return
      finish()
      if (!active) return
      swallowNextClick()
      options.onDrop(e.clientX, e.clientY)
    }
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return
      finish()
      if (active) options.onCancel()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active) return
      e.preventDefault()
      e.stopPropagation()
      finish()
      options.onCancel()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('keydown', key, true)
  })
  // The browser's own drag (of text or an image inside) would take the pointer away.
  el.addEventListener('dragstart', (e) => e.preventDefault())
}

/** The click a release fires after a drag is not a click on the row. */
function swallowNextClick(): void {
  const swallow = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

/** A copy of `el` that follows the pointer while it is dragged. */
export function ghostOf(el: HTMLElement, x: number, y: number): { move: (x: number, y: number) => void; remove: () => void } {
  const rect = el.getBoundingClientRect()
  const ghost = el.cloneNode(true) as HTMLElement
  const dx = x - rect.left
  const dy = y - rect.top
  ghost.classList.remove('dragging', 'selected', 'insert-before', 'insert-after')
  ghost.classList.add('drag-ghost')
  ghost.removeAttribute('id')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, { width: `${rect.width}px`, left: '0', top: '0', transform: `translate(${x - dx}px, ${y - dy}px)` })
  document.body.appendChild(ghost)
  return {
    move: (nx, ny) => {
      ghost.style.transform = `translate(${nx - dx}px, ${ny - dy}px)`
    },
    remove: () => ghost.remove()
  }
}

/** Scrolls the areas under the pointer while it sits near their edges, until stopped. */
export function autoScroll(areas: () => HTMLElement[]): { at: (x: number, y: number) => void; stop: () => void } {
  let x = 0
  let y = 0
  let frame = 0
  const step = () => {
    frame = 0
    let moved = false
    for (const area of areas()) {
      const r = area.getBoundingClientRect()
      const insideX = x >= r.left && x <= r.right
      const insideY = y >= r.top && y <= r.bottom
      const vy = insideX && area.scrollHeight > area.clientHeight ? edgeScroll(y, r.top, r.bottom) : 0
      const vx = insideY && area.scrollWidth > area.clientWidth ? edgeScroll(x, r.left, r.right) : 0
      if (vy || vx) {
        const beforeTop = area.scrollTop
        const beforeLeft = area.scrollLeft
        area.scrollTop += vy
        area.scrollLeft += vx
        moved ||= area.scrollTop !== beforeTop || area.scrollLeft !== beforeLeft
      }
    }
    if (moved) frame = requestAnimationFrame(step)
  }
  return {
    at: (nx, ny) => {
      x = nx
      y = ny
      if (!frame) frame = requestAnimationFrame(step)
    },
    stop: () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
