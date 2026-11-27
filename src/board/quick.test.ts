// The hover quick actions (quick.ts): which status icons a row or card shows, and in what order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyStatusOp, DEFAULT_STATUSES } from '../core/statuses.ts'
import type { StatusDef } from '../core/types.ts'
import { keyTarget, QUICK_ROOM, quickIcon, quickStatuses } from './quick.ts'

const statuses = DEFAULT_STATUSES.map((s) => ({ ...s }))
const ids = (list: StatusDef[]) => list.map((s) => s.id)

test('one icon per status but the current one, in the order of the statuses, each by its kind', () => {
  assert.deepEqual(ids(quickStatuses(statuses, 'todo', QUICK_ROOM.sidebar).shown), ['in-progress', 'pending', 'done', 'cancelled'])
  assert.deepEqual(ids(quickStatuses(statuses, 'done', QUICK_ROOM.sidebar).shown), ['todo', 'in-progress', 'pending', 'cancelled'])
  assert.deepEqual(statuses.map((s) => quickIcon(s, 'in-progress')), ['circle', 'play', 'clock', 'check', 'close'])
})

test('when they do not fit, Done, Pending and Cancelled first; the rest go to the … menu', () => {
  const card = quickStatuses(statuses, 'todo', QUICK_ROOM.card)
  assert.deepEqual([ids(card.shown), ids(card.more)], [['pending', 'done', 'cancelled'], ['in-progress']])
  let many = statuses
  for (const name of ['Review', 'Blocked', 'Shipped']) many = applyStatusOp(many, { op: 'add', name, kind: name === 'Blocked' ? 'hold' : name === 'Shipped' ? 'done' : 'open' }).statuses
  const row = quickStatuses(many, 'in-progress', QUICK_ROOM.sidebar)
  assert.deepEqual([ids(row.shown), ids(row.more)], [['todo', 'pending', 'done', 'cancelled'], ['review', 'blocked', 'shipped']])
  assert.equal(ids(quickStatuses(many, 'todo', QUICK_ROOM.list).shown).length, 6)
})

test('without a status of a kind (Cancelled deleted), nothing is made up: the icons are the statuses there are', () => {
  const noCancel = applyStatusOp(statuses, { op: 'remove', id: 'cancelled' }).statuses
  assert.deepEqual(ids(quickStatuses(noCancel, 'todo', QUICK_ROOM.card).shown), ['in-progress', 'pending', 'done'])
  assert.deepEqual(ids(quickStatuses(noCancel, 'todo', 2).shown), ['pending', 'done'])
  assert.equal(keyTarget(noCancel, 'todo', 'cancelled'), null)
})

test('P and C: to the first on-hold or cancelled status, and back to the first open one from there', () => {
  assert.equal(keyTarget(statuses, 'todo', 'hold')?.id, 'pending')
  assert.equal(keyTarget(statuses, 'in-progress', 'cancelled')?.id, 'cancelled')
  assert.equal(keyTarget(statuses, 'pending', 'hold')?.id, 'todo', 'P again takes it off hold')
  assert.equal(keyTarget(statuses, 'cancelled', 'cancelled')?.id, 'todo', 'C again reopens it')
})
