// The back/forward diagnostics the page sends to the worker's log (nav-log.ts): which events, how
// many, and what a line says (never anything typed or about tasks).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkNavLog, navLine, navMods, navStartLine, NavThrottle, navWorthy } from './nav-log.ts'

test('the events worth a line: thumb buttons, Back/Forward keys, a sideways wheel, the page navigating', () => {
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick']) {
    assert.equal(navWorthy({ type, button: 3, buttons: 8 }), true, type)
    assert.equal(navWorthy({ type, button: 0, buttons: 1 }), false, `${type}: a left click is not`)
  }
  assert.equal(navWorthy({ type: 'pointerdown', button: 0, buttons: 9 }), true, 'a thumb button held (buttons & 8)')
  assert.equal(navWorthy({ type: 'mouseup', button: 4, buttons: 0 }), true)
  assert.equal(navWorthy({ type: 'auxclick', button: 1, buttons: 0 }), false, 'the middle button is not')
  assert.equal(navWorthy({ type: 'keydown', key: '[', code: 'BracketLeft', meta: true }), true)
  assert.equal(navWorthy({ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true }), true, "Orca's own Worktree History Back chord")
  assert.equal(navWorthy({ type: 'keydown', key: 'ArrowRight', code: 'ArrowRight', ctrl: true }), true)
  assert.equal(navWorthy({ type: 'keydown', key: 'BrowserBack', code: 'BrowserBack' }), true)
  assert.equal(navWorthy({ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft' }), false, 'a plain arrow is not')
  assert.equal(navWorthy({ type: 'keydown', key: 'v', code: 'KeyV', meta: true }), false, 'Cmd+V is not')
  assert.equal(navWorthy({ type: 'keydown', key: '[', code: 'BracketLeft' }), false, 'typing [ is not')
  assert.equal(navWorthy({ type: 'wheel', deltaX: -120, deltaY: 4 }), true)
  assert.equal(navWorthy({ type: 'wheel', deltaX: -12, deltaY: 0 }), false, 'a nudge is not')
  assert.equal(navWorthy({ type: 'wheel', deltaX: 60, deltaY: 100 }), false, 'scrolling down is not')
  for (const type of ['popstate', 'hashchange', 'pagehide', 'beforeunload', 'navigate']) assert.equal(navWorthy({ type }), true, type)
  assert.equal(navWorthy({ type: 'click', button: 0 }), false)
  assert.equal(navMods({ meta: true, alt: true }), 'meta+alt')
  assert.equal(navMods({}), '')
})

test('at most 20 at once and 2 a second after that; a sideways wheel once per 500 ms', () => {
  const t = new NavThrottle()
  let allowed = 0
  for (let i = 0; i < 30; i += 1) if (t.allow('pointerdown', 0)) allowed += 1
  assert.deepEqual([allowed, t.dropped], [20, 10])
  assert.equal(t.allow('pointerdown', 400), false, '0.8 of a line back: not yet')
  assert.equal(t.allow('pointerdown', 600), true)
  const w = new NavThrottle()
  assert.deepEqual([w.allow('wheel', 0), w.allow('wheel', 100), w.allow('wheel', 499), w.allow('wheel', 600)], [true, false, false, true])
  assert.equal(w.dropped, 0, 'a swipe\'s other wheel events are not counted as left out')
})

test('the worker takes short words and numbers only: no typed text, no task content', () => {
  const { start, entries, dropped } = checkNavLog({
    start: { surface: 'sidebar', views: ['list', 'details'], events: ['pointerdown', 'keydown'], top: true, focus: false, hostApi: '1.9', platform: 'MacIntel' },
    entries: [
      { surface: 'sidebar', view: 'list+details', type: 'pointerdown', button: 3, buttons: 8, pointerType: 'mouse', mods: '', target: 'row', focus: false, taken: 'stopped' },
      { surface: 'board', view: 'board', type: 'keydown', key: 'q', code: 'KeyQ', mods: 'meta', target: 'page', focus: true, taken: 'none' },
      { surface: 'board', view: 'Fix the login bug', type: 'wheel', deltaX: -120.6, deltaY: 0, mods: '', target: 'page', focus: true, taken: 'none' },
      'junk'
    ],
    dropped: 4
  })
  assert.equal(dropped, 4)
  assert.equal(navStartLine(start!), 'nav listeners attached: sidebar (views list, details; top frame; focus=no; host API 1.9; MacIntel): pointerdown, keydown')
  assert.deepEqual(entries.map(navLine), [
    'nav sidebar/list+details pointerdown button=3 buttons=8 pointer=mouse mods=none on=row focus=no -> stopped',
    'nav board/board keydown key=? code=? mods=meta on=page focus=yes -> none',
    'nav board/? wheel dx=-121 dy=0 mods=none on=page focus=yes -> none'
  ])
  assert.deepEqual(checkNavLog(null), { start: null, entries: [], dropped: 0, debug: false })
  assert.equal(checkNavLog({ debug: true }).debug, true, 'the page\'s console switch')
  assert.equal(checkNavLog({ entries: Array.from({ length: 80 }, () => ({ type: 'auxclick' })) }).entries.length, 50)
})
