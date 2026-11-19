/**
 * 面板路径约定：两侧必须同名同路径，规则只在这一个纯函数里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_DIR, PANEL_SUFFIX, safeFileName, panelRelativePath } from '../lib/panel-path.js'

test('默认目录与后缀是面板的对外约定', () => {
  assert.equal(PANEL_DIR, '.dsh/ledger')
  assert.equal(PANEL_SUFFIX, '.json')
})

test('清洗非法字符，空值退化为 unknown', () => {
  assert.equal(safeFileName('session-9f2a41'), 'session-9f2a41')
  assert.equal(safeFileName('../../etc/passwd'), '______etc_passwd')
  assert.equal(safeFileName(''), 'unknown')
  assert.equal(safeFileName(undefined), 'unknown')
  assert.equal(safeFileName(12345), 'unknown')
})

test('相对路径拼法与 Host 写盘一致，且不含反斜杠', () => {
  assert.equal(panelRelativePath('session-abc'), '.dsh/ledger/session-abc.json')
  assert.equal(panelRelativePath('a/b'), '.dsh/ledger/a_b.json')
  assert.equal(panelRelativePath('s', 'custom/dir'), 'custom/dir/s.json')
  assert.ok(!panelRelativePath('s').includes('\\'))
})
