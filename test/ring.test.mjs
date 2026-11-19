import test from 'node:test'
import assert from 'node:assert/strict'
import { RingBuffer } from '../lib/ring.js'

test('未满时按顺序追加', () => {
  const r = new RingBuffer(3)
  r.push(1); r.push(2)
  assert.deepEqual(r.toArray(), [1, 2])
  assert.equal(r.size, 2)
})

test('写满后淘汰最旧，且顺序正确', () => {
  const r = new RingBuffer(3)
  for (let i = 1; i <= 5; i += 1) r.push(i)
  assert.deepEqual(r.toArray(), [3, 4, 5])
  assert.equal(r.size, 3)
})

test('last(n) 与 clear()', () => {
  const r = new RingBuffer(4)
  for (let i = 0; i < 6; i += 1) r.push(i)
  assert.deepEqual(r.last(2), [4, 5])
  assert.deepEqual(r.last(99), [2, 3, 4, 5])
  r.clear()
  assert.deepEqual(r.toArray(), [])
})

test('容量非法直接拒绝', () => {
  assert.throws(() => new RingBuffer(0), TypeError)
  assert.throws(() => new RingBuffer(1.5), TypeError)
})
