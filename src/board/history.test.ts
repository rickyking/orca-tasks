// The mouse's back and forward buttons (history.ts): what Back closes, the views it goes back
// through, Forward, and that every event of those buttons is stopped (the frame never navigates).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backAction, forwardAction, MOUSE_BACK, MOUSE_FORWARD, mouseNav, ViewHistory, type View } from './history.ts'
import { keyAction, shortcutList, type KeyScreen } from './keys.ts'

const SCREEN: KeyScreen = { sidebar: false, menu: false, help: false, form: null, suggestions: false, draft: false, armed: false, details: false, settings: false, picked: false }
const view = (more: Partial<View> = {}): View => ({ view: 'list', filter: 'all', project: '', selected: null, ...more })

test('the back and forward buttons: every event is stopped, the step is taken on release', () => {
  assert.equal(MOUSE_BACK, 3, "an MX Master's thumb back button")
  assert.equal(MOUSE_FORWARD, 4)
  for (const type of ['mousedown', 'auxclick']) {
    assert.deepEqual(mouseNav(type, 3), { prevent: true, step: null }, `${type}: stopped, no step (no double step)`)
    assert.deepEqual(mouseNav(type, 4), { prevent: true, step: null })
  }
  assert.deepEqual(mouseNav('mouseup', 3), { prevent: true, step: 'back' })
  assert.deepEqual(mouseNav('mouseup', 4), { prevent: true, step: 'forward' })
  for (const button of [0, 1, 2]) for (const type of ['mousedown', 'mouseup', 'auxclick']) assert.deepEqual(mouseNav(type, button), { prevent: false, step: null }, `button ${button} is left alone`)
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
    assert.ok(keys.includes('Mouse back button') && keys.includes('Mouse forward button'), 'listed under ?')
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
