// The mouse's back and forward buttons (history.ts): what Back closes, the views it goes back
// through, Forward, and that every event of those buttons is stopped (the frame never navigates).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backAction, forwardAction, MOUSE_BACK, MOUSE_FORWARD, MOUSE_NAV_EVENTS, MouseNav, ViewHistory, type View } from './history.ts'
import { keyAction, shortcutList, type KeyPress, type KeyScreen } from './keys.ts'

const SCREEN: KeyScreen = { sidebar: false, menu: false, help: false, form: null, suggestions: false, draft: false, armed: false, details: false, settings: false, picked: false }
const view = (more: Partial<View> = {}): View => ({ view: 'list', filter: 'all', project: '', selected: null, ...more })

test('the back and forward buttons: every event is stopped, one step per press, from whichever events arrive', () => {
  assert.equal(MOUSE_BACK, 3, "an MX Master's thumb back button")
  assert.equal(MOUSE_FORWARD, 4)
  const steps = (events: [string, number, number][]) => {
    const nav = new MouseNav()
    return events.map(([type, button, time]) => nav.event(type, button, time))
  }
  // All five events of one press: stopped, and one step, on the first release.
  const full = steps(MOUSE_NAV_EVENTS.map((type, i) => [type, 3, 100 + i]))
  assert.ok(full.every((r) => r.prevent))
  assert.deepEqual(full.map((r) => r.step), [null, null, 'back', null, null])
  // A cancelled pointerdown drops the mouse events: the pointer events alone still step.
  assert.deepEqual(steps([['pointerdown', 3, 0], ['pointerup', 3, 5]]).map((r) => r.step), [null, 'back'])
  // Only the mouse events (an older frame), or only auxclick (some drivers): a step too.
  assert.deepEqual(steps([['mousedown', 4, 0], ['mouseup', 4, 5], ['auxclick', 4, 6]]).map((r) => r.step), [null, 'forward', null])
  assert.deepEqual(steps([['auxclick', 3, 0]]).map((r) => r.step), ['back'])
  // Two presses in a row are two steps; release events alone count again after a moment.
  assert.deepEqual(steps([['pointerdown', 3, 0], ['pointerup', 3, 5], ['mouseup', 3, 6], ['pointerdown', 3, 50], ['pointerup', 3, 55]]).map((r) => r.step), [null, 'back', null, null, 'back'])
  assert.deepEqual(steps([['auxclick', 3, 0], ['auxclick', 3, 100], ['auxclick', 3, 1000]]).map((r) => r.step), ['back', null, 'back'])
  for (const button of [0, 1, 2]) for (const type of MOUSE_NAV_EVENTS) assert.deepEqual(new MouseNav().event(type, button, 0), { prevent: false, step: null }, `button ${button} is left alone`)
})

test('Cmd+[ and Cmd+] (what mouse software on macOS sends for the thumb buttons), and Cmd+Left / Cmd+Right, are Back and Forward', () => {
  const press = (key: string, more: Partial<KeyPress> = {}) => keyAction({ key, meta: true, ctrl: false, alt: false, shift: false, target: 'page', ...more }, SCREEN)
  assert.deepEqual(press('['), { leave: false, action: 'back' })
  assert.deepEqual(press(']'), { leave: false, action: 'forward' })
  assert.deepEqual(press('ü', { code: 'BracketLeft' }), { leave: false, action: 'back' }, 'the physical key, on another layout')
  assert.deepEqual(press('[', { target: 'field', field: 'details' }), { leave: true, action: 'back' }, 'from a field: it is left (and saved) first')
  assert.deepEqual(press('ArrowLeft', { target: 'task' }), { leave: false, action: 'back' })
  assert.deepEqual(press('ArrowRight'), { leave: false, action: 'forward' })
  assert.deepEqual(press('ArrowLeft', { target: 'field', field: 'details' }), { leave: false, action: 'none' }, 'in a field Cmd+Left moves the caret')
  assert.equal(press('[', { ctrl: true }).action, 'none')
  assert.equal(press('[', { meta: false }).action, 'none', '[ alone is not a shortcut')
})

test('Back closes what is on top, as Esc does, before it goes back a view', () => {
  const all: Partial<KeyScreen> = { menu: true, help: true, form: 'send', details: true, settings: true, picked: true }
  assert.equal(backAction({ ...SCREEN, ...all }, true), 'close-menu')
  assert.equal(backAction({ ...SCREEN, ...all, menu: false }, true), 'close-help')
  assert.equal(backAction({ ...SCREEN, ...all, menu: false, help: false }, true), 'close-form')
  assert.equal(backAction({ ...SCREEN, form: 'send', draft: true, details: true }, true), 'warn-draft', 'a typed instruction is not dropped on the first Back')
  assert.equal(backAction({ ...SCREEN, form: 'send', draft: true, armed: true, details: true }, true), 'close-form')
  assert.equal(backAction({ ...SCREEN, details: true }, true), 'close-details', 'the open task closes first')
  assert.equal(backAction({ ...SCREEN, settings: true }, true), 'close-settings')
  assert.equal(backAction({ ...SCREEN, picked: true }, true), 'clear-picked')
  assert.equal(backAction(SCREEN, true), 'view-back')
  assert.equal(backAction(SCREEN, false), 'none', 'nothing before: nothing happens (and the frame stays)')
  assert.equal(forwardAction(SCREEN, true), 'view-forward')
  assert.equal(forwardAction(SCREEN, false), 'none')
  assert.equal(forwardAction({ ...SCREEN, form: 'merge' }, true), 'none', 'not under an open form')
})

test('the Browser Back / Forward keys are Back and Forward, also in a field', () => {
  const press = (key: string, target: 'page' | 'field' = 'page') => keyAction({ key, meta: false, ctrl: false, alt: false, shift: false, target, ...(target === 'field' ? { field: 'details' as const } : {}) }, SCREEN)
  assert.deepEqual(press('BrowserBack'), { leave: false, action: 'back' })
  assert.deepEqual(press('BrowserForward'), { leave: false, action: 'forward' })
  assert.deepEqual(press('BrowserBack', 'field'), { leave: true, action: 'back' }, 'a details field saves as it is left')
  for (const sidebar of [true, false]) {
    const keys = shortcutList(sidebar).map(([k]) => k)
    assert.ok(keys.includes('Mouse back button, Cmd+[') && keys.includes('Mouse forward button, Cmd+]'), 'listed under ?')
  }
})

test('the view history: filters, project and list or board are steps; the open task is not', () => {
  const h = new ViewHistory()
  h.note(view())
  assert.equal(h.canGoBack(), false, 'the first view has nothing before it')
  h.note(view({ selected: 't-1' }))
  h.note(view({ selected: 't-2' }))
  assert.equal(h.canGoBack(), false, 'opening tasks (J/K) is not a step')
  h.note(view({ filter: 'today', selected: 't-2' }))
  h.note(view({ filter: 'today', project: 'web' }))
  h.note(view({ filter: 'today', project: 'web', view: 'board' }))
  h.note(view({ filter: 'today', project: 'web', view: 'board' }))
  assert.deepEqual(h.back(), view({ filter: 'today', project: 'web' }), 'list or board')
  assert.deepEqual(h.back(), view({ filter: 'today' }), 'the project; no task reopens going back')
  assert.deepEqual(h.back(), view(), 'the filter')
  assert.equal(h.back(), null)
  assert.deepEqual(h.forward(), view({ filter: 'today' }), 'forward: the view, as Back showed it')
  assert.deepEqual(h.forward(), view({ filter: 'today', project: 'web' }))
  // A new step drops what was forward.
  h.note(view({ filter: 'overdue', project: 'web' }))
  assert.equal(h.canGoForward(), false)
  assert.deepEqual(h.back(), view({ filter: 'today', project: 'web' }))
})

test('Back closes the open task and Forward opens it again; opening another drops that', () => {
  const h = new ViewHistory()
  h.note(view({ filter: 'today' }))
  h.note(view({ filter: 'today', selected: 't-1' }))
  h.closedTask()
  h.note(view({ filter: 'today' }))
  assert.equal(h.canGoForward(), true)
  assert.deepEqual(h.forward(), view({ filter: 'today', selected: 't-1' }))
  assert.equal(h.canGoBack(), false, 'reopening is not a step back to take')
  h.closedTask()
  h.note(view({ filter: 'today' }))
  h.note(view({ filter: 'today', selected: 't-9' }))
  assert.equal(h.canGoForward(), false, 'another task opened by hand')
  h.reset(view({ view: 'board' }))
  assert.deepEqual([h.canGoBack(), h.canGoForward()], [false, false])
  // It keeps the last 50 steps.
  for (let i = 0; i < 80; i += 1) h.note(view({ project: `p${i}` }))
  let steps = 0
  while (h.back()) steps += 1
  assert.equal(steps, 50)
})
