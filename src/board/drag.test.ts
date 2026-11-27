// The pure parts of dragging on the board and in the sidebar; plain node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgeScroll, insertionIndex, moveIndex, pastThreshold } from './drag.ts'

test('a press becomes a drag only past the threshold', () => {
  assert.equal(pastThreshold(2, 2), false)
  assert.equal(pastThreshold(3, 4), true)
  assert.equal(pastThreshold(0, -6), true)
})

test('where a dragged item lands among rows, and the index to move it to', () => {
  const rows = [
    { top: 0, bottom: 20 },
    { top: 20, bottom: 40 },
    { top: 40, bottom: 60 }
  ]
  assert.equal(insertionIndex(-5, rows), 0)
  assert.equal(insertionIndex(9, rows), 0, 'above the middle of the first row')
  assert.equal(insertionIndex(11, rows), 1)
  assert.equal(insertionIndex(55, rows), 3, 'past the middle of the last row: after it')
  assert.equal(insertionIndex(10, []), 0)
  assert.equal(moveIndex(0, 3), 2, 'first to the end')
  assert.equal(moveIndex(2, 0), 0, 'last to the top')
  assert.equal(moveIndex(1, 1), 1, 'dropped where it was')
  assert.equal(moveIndex(1, 2), 1, 'dropped just below itself: no move')
})

test('scrolling near the edges of an area while dragging', () => {
  assert.equal(edgeScroll(200, 0, 400), 0, 'in the middle')
  assert.ok(edgeScroll(2, 0, 400) < 0, 'near the top: up')
  assert.ok(edgeScroll(398, 0, 400) > 0, 'near the bottom: down')
  assert.ok(Math.abs(edgeScroll(1, 0, 400)) > Math.abs(edgeScroll(30, 0, 400)), 'faster at the edge')
  assert.equal(edgeScroll(500, 0, 400), 0, 'far outside')
  assert.equal(edgeScroll(5, 0, 60), 0, 'too small to scroll by its edges')
})
