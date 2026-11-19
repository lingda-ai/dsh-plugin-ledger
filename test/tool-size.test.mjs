import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultChars, formatChars } from '../lib/tool-size.js'

test('只数 text 块：图片与非文本块不计入上下文体积', () => {
  assert.equal(toolResultChars({ content: [{ type: 'text', text: 'abc' }, { type: 'image', url: 'x' }] }), 3)
})

test('多 text 块累加', () => {
  assert.equal(toolResultChars({ content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cde' }] }), 5)
})

test('没有 content 或形状不对时给 0，不抛', () => {
  assert.equal(toolResultChars(null), 0)
  assert.equal(toolResultChars({}), 0)
  assert.equal(toolResultChars({ content: 'not-an-array' }), 0)
  assert.equal(toolResultChars({ content: [null, 'x'] }), 0)
})

test('formatChars：小数字不缩写，上万才用 k', () => {
  assert.equal(formatChars(512), '512 字符')
  assert.equal(formatChars(9999), '9,999 字符')
  assert.equal(formatChars(18_442), '18.4k 字符')
  assert.equal(formatChars(null), null)
})

test('真实形状的 tool/result 也能数（content 里有 text）', () => {
  const message = {
    role: 'tool',
    toolCallId: 'c1',
    content: [{ type: 'text', text: 'x'.repeat(5000) }],
    source: { type: 'tool' },
  }
  assert.equal(toolResultChars(message), 5000)
})
