/**
 * 卸载零残留：插件在 DSH 里会被热插拔，卸载漏掉一个订阅或一个定时器就是内存泄漏。
 *
 * 这里模拟 cordis fiber 的语义：effect 注册的清理在 dispose 时执行，
 * 本 ctx 上的订阅随之解除（真实宿主由 cordis 负责，替身必须自己实现，
 * 否则测试会因为"订阅还在"而永远假绿）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { createTraceSink } from '../lib/trace-file.js'

function makeCtx() {
  const handlers = new Map()
  const cleanups = []
  const registered = []
  let disposed = false
  return {
    handlers,
    registered,
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    provide() {},
    tools: { register(def) { registered.push(def); return () => {} } },
    effect(fn) { cleanups.push(fn); return () => {} },
    /** 等价于 cordis 的 fiber dispose：先跑清理，再解除订阅 */
    dispose() {
      if (disposed) return
      disposed = true
      for (const fn of cleanups.reverse()) fn()
      handlers.clear()
      registered.length = 0
    },
  }
}

const MODEL = {
  type: 'assistant/message',
  turn: 2,
  step: 2,
  message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
}

test('U-1 面板卸载后不再落盘、不再处理事件', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-uninstall-'))
  try {
    const ctx = makeCtx()
    const api = apply(ctx, { panel: { enabled: true, dir: '.dsh/ledger', intervalMs: 0 } })
    const session = { id: 's-u1', header: { cwd: root } }

    ctx.emit('session/event', session, { type: 'tool/call', turn: 2, step: 1, name: 'food.query', callId: 'c1' })
    ctx.emit('session/event', session, MODEL)
    const file = join(root, '.dsh', 'ledger', 's-u1.json')
    assert.ok(existsSync(file), '装载期间应落盘')
    const before = readFileSync(file, 'utf8')
    const writesBefore = api.panel.stats.writes

    ctx.dispose()
    assert.equal(ctx.handlers.size, 0, '卸载后本 ctx 的订阅必须全部解除')
    assert.equal(ctx.registered.length, 0, '工具注册必须归还')

    // 卸载后再来事件：不应再计数，也不应再写盘
    ctx.emit('session/event', session, MODEL)
    ctx.emit('session/event', session, MODEL)
    const after = readFileSync(file, 'utf8')
    assert.equal(after, before, '卸载后快照内容不该再变')
    assert.equal(api.panel.stats.writes, writesBefore, '卸载后不该再有写盘')

    // 幂等：重复 dispose 不抛（热重载会重复调）
    ctx.dispose()
    ctx.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U-2 流水落盘的定时器在 dispose 后必须停', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-trace-'))
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const sink = createTraceSink({ dir: '.dsh/ledger', rootOf: () => root, intervalMs: 50, maxBytes: 1 << 20 })
    sink.append('s-u2', { a: 1 })
    sink.append('s-u2', { a: 2 })
    await wait(120)
    const file = sink.filePathOf('s-u2')
    assert.ok(existsSync(file), '定时器应把队列落盘')
    const lines1 = readFileSync(file, 'utf8').trim().split('\n').length
    assert.equal(lines1, 2)

    sink.dispose()
    sink.dispose() // 幂等
    const linesWritten = sink.stats.lines

    // 卸载后再 append：定时器已清，队列里的东西不该再写进文件
    sink.append('s-u2', { a: 3 })
    await wait(150)
    const lines2 = readFileSync(file, 'utf8').trim().split('\n').length
    assert.equal(lines2, lines1, 'dispose 后定时器必须真的停了（否则就是泄漏）')
    assert.equal(sink.stats.lines, linesWritten, 'dispose 后不该再写出任何行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U-3 会话销毁：armed 与流水队列一起释放（长跑不累积）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-forget-'))
  try {
    const ctx = makeCtx()
    const api = apply(ctx, {
      budget: { limit: 0.01, threshold: 0.8 },
      trace: { enabled: true, file: { enabled: true, maxBytes: 1 << 20 } },
      panel: { enabled: true, dir: '.dsh/ledger', intervalMs: 0 },
    })
    const session = { id: 's-u3', header: { cwd: root } }
    // 先花掉超过 80% 预算，触发一次投递（没有 agent 时 deliver 走不到，但 armed 会置位）
    for (let i = 0; i < 3; i += 1) {
      ctx.emit('session/event', session, {
        type: 'assistant/message',
        turn: 1,
        step: i,
        message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
    }

    // 会话销毁后再来同一 id：状态若没释放，会表现为"这条会话不再投递/不再写盘"
    ctx.emit('session/disposed', session)
    assert.equal(api.stats().sessions, 0, '会话销毁后不该还留着账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
