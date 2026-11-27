// The sidebar's and the board's keys (keys.ts): what each press does, and that typing in a field
// is never taken as a shortcut.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyAction, moveCursor, shortcutList, type KeyPress, type KeyScreen } from './keys.ts'

const SCREEN: KeyScreen = { sidebar: false, menu: false, help: false, form: null, suggestions: false, draft: false, armed: false, details: false, settings: false, picked: false }
const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({ key, meta: false, ctrl: false, alt: false, shift: false, target: 'page', ...more })
const act = (key: string, more: Partial<KeyPress> = {}, screen: Partial<KeyScreen> = {}) => keyAction(press(key, more), { ...SCREEN, ...screen })

test('keys on the page: move, open, tick, add, search, view, help', () => {
  assert.deepEqual(act('j'), { leave: false, action: 'next' })
  assert.deepEqual(act('ArrowDown'), { leave: false, action: 'next' })
  assert.deepEqual(act('k'), { leave: false, action: 'previous' })
  assert.deepEqual(act('ArrowUp'), { leave: false, action: 'previous' })
  assert.equal(act('J').action, 'next', 'caps lock')
  assert.equal(act('Enter').action, 'open')
  assert.equal(act('Enter', { target: 'task' }).action, 'open', 'a focused row')
  assert.equal(act('x').action, 'toggle-done')
  assert.equal(act(' ').action, 'toggle-done')
  assert.equal(act(' ', { target: 'task' }).action, 'toggle-done')
  assert.equal(act('p').action, 'pending')
  assert.equal(act('c').action, 'cancel')
  assert.equal(act('P', { shift: true }).action, 'none')
  assert.equal(act('p', { meta: true }).action, 'none', 'Cmd+P is not P')
  assert.equal(act('n').action, 'quick-add')
  assert.equal(act('/').action, 'search', 'the board has a search box')
  assert.equal(act('/', {}, { sidebar: true }).action, 'quick-add', 'the sidebar has none: / adds')
  assert.equal(act('v').action, 'toggle-view')
  assert.equal(act('v', {}, { sidebar: true }).action, 'none', 'the sidebar is always a list')
  assert.equal(act('?', { shift: true }).action, 'help')
  assert.equal(act('q').action, 'none')
  assert.equal(act('ArrowLeft').action, 'none')
})

test('typing in a field is never a shortcut', () => {
  for (const field of ['box', 'details', 'form', 'other'] as const) {
    for (const key of ['j', 'k', 'x', ' ', 'p', 'c', 'n', '/', 'v', '?', 'Enter', 'ArrowDown', 'ArrowUp', 'J', 'X']) {
      assert.deepEqual(act(key, { target: 'field', field }), { leave: false, action: 'none' }, `${key} in a ${field} field`)
      assert.deepEqual(act(key, { target: 'field', field }, { details: true, form: 'send' }), { leave: false, action: 'none' }, `${key} in a ${field} field, details open`)
    }
    assert.equal(act('Enter', { target: 'field', field, shift: true }).action, 'none')
  }
})

test('modifier chords and a focused button are left alone', () => {
  for (const key of ['j', 'k', 'x', 'n', 'v', 'Enter', 'ArrowDown'])
    for (const mod of [{ meta: true }, { ctrl: true }, { alt: true }]) assert.equal(act(key, mod).action, 'none', `${key} ${JSON.stringify(mod)}`)
  assert.equal(act('Enter', { target: 'button' }).action, 'none', 'Enter presses the button')
  assert.equal(act(' ', { target: 'button' }).action, 'none', 'Space presses the button')
  assert.equal(act('x', { target: 'button' }).action, 'toggle-done', 'other keys still work beside a button')
  assert.equal(act('j', {}, { menu: true }).action, 'none', 'the status menu has its own keys')
})

test('Esc closes from the top down: menu, shortcuts, form, details, Statuses, picked', () => {
  const all: Partial<KeyScreen> = { menu: true, help: true, form: 'send', details: true, settings: true, picked: true }
  assert.equal(act('Escape', {}, all).action, 'close-menu')
  assert.equal(act('Escape', {}, { ...all, menu: false }).action, 'close-help')
  assert.equal(act('Escape', {}, { ...all, menu: false, help: false }).action, 'close-form')
  assert.equal(act('Escape', {}, { form: 'merge', details: false }).action, 'close-form', 'the merge confirm step')
  assert.equal(act('Escape', {}, { form: 'merge', suggestions: true }).action, 'close-form', 'a suggestion opened in the merge step: the step first')
  assert.equal(act('Escape', {}, { suggestions: true, details: true }).action, 'close-suggestions', 'then the suggestions')
  assert.equal(act('Escape', {}, { details: true, settings: true, picked: true }).action, 'close-details')
  assert.equal(act('Escape', {}, { settings: true, picked: true }).action, 'close-settings')
  assert.equal(act('Escape', {}, { picked: true }).action, 'clear-picked')
  assert.deepEqual(act('Escape'), { leave: false, action: 'none' })
  assert.equal(act('Escape', { target: 'task' }, { details: true }).action, 'close-details')
  assert.equal(act('Escape', { target: 'button' }, { details: true }).action, 'close-details')
})

test('Esc never drops typed text without a word: a typed instruction asks once', () => {
  // A send form with an instruction typed: the first Esc warns, the second discards.
  assert.equal(act('Escape', {}, { form: 'send', draft: true, details: true }).action, 'warn-draft')
  assert.equal(act('Escape', {}, { form: 'project', draft: true, armed: true, details: true }).action, 'close-form')
  // In the instruction field itself: leave it, and warn.
  assert.deepEqual(act('Escape', { target: 'field', field: 'form' }, { form: 'send', draft: true, details: true }), { leave: true, action: 'warn-draft' })
  assert.deepEqual(act('Escape', { target: 'field', field: 'form' }, { form: 'send', draft: false, details: true }), { leave: true, action: 'close-form' }, 'nothing typed: it closes')
  // A details field saves as it is left (its blur handler), then the details close.
  assert.deepEqual(act('Escape', { target: 'field', field: 'details' }, { details: true }), { leave: true, action: 'close-details' })
  // Quick add and search keep what was typed and only lose the focus; so do Statuses' fields.
  assert.deepEqual(act('Escape', { target: 'field', field: 'box' }, { details: true }), { leave: true, action: 'none' })
  assert.deepEqual(act('Escape', { target: 'field', field: 'other' }, { settings: true }), { leave: true, action: 'none' })
})

test('Cmd/Ctrl+Enter saves a details field and sends a form', () => {
  assert.deepEqual(act('Enter', { target: 'field', field: 'details', meta: true }, { details: true }), { leave: true, action: 'save' })
  assert.deepEqual(act('Enter', { target: 'field', field: 'details', ctrl: true }, { details: true }), { leave: true, action: 'save' })
  assert.deepEqual(act('Enter', { target: 'field', field: 'form', meta: true }, { form: 'send' }), { leave: false, action: 'submit' })
  assert.equal(act('Enter', { target: 'field', field: 'box', meta: true }).action, 'none')
  assert.equal(act('Enter', { meta: true }).action, 'none', 'not on the page')
})

test('the cursor moves through the tasks shown and stops at the ends', () => {
  const order = ['a', 'b', 'c']
  assert.equal(moveCursor(order, null, 1), 'a')
  assert.equal(moveCursor(order, null, -1), 'c')
  assert.equal(moveCursor(order, 'a', 1), 'b')
  assert.equal(moveCursor(order, 'c', 1), 'c')
  assert.equal(moveCursor(order, 'a', -1), 'a')
  assert.equal(moveCursor(order, 'gone', 1), 'a', 'a task no longer shown starts over')
  assert.equal(moveCursor([], 'a', 1), null)
})

test('the shortcuts list matches the surface', () => {
  const board = shortcutList(false).map(([k]) => k)
  const sidebar = shortcutList(true).map(([k]) => k)
  for (const k of ['Esc', '?', 'Enter', 'Cmd/Ctrl+Enter']) {
    assert.ok(board.includes(k), k)
    assert.ok(sidebar.includes(k), k)
  }
  assert.ok(board.includes('V') && !sidebar.includes('V'))
  assert.ok(sidebar.includes('N  or  /'))
})
