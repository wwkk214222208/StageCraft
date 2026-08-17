import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStateUpdateKeys } from '../src/model-gateway.ts'

test('stateUpdates 接受角色中文名与玩家名作为键并归一化', () => {
  const roleNames = new Map([['苏棠', 'sutang'], ['露西菲尔', 'lucifer'], ['埃莉诺', 'elanor']])
  const normalized = normalizeStateUpdateKeys(
    { '苏棠': '归煦圣母，神情温和。', '露西菲尔': '静立一旁。', '怀夕': '正低头看修女服。', 'player': '同上。' },
    { roleNames, playerName: '怀夕' },
  )
  assert.deepEqual(normalized, { sutang: '归煦圣母，神情温和。', lucifer: '静立一旁。', player: '同上。' })
})

test('未知键保留原样，交给下游校验决定是否报错', () => {
  const normalized = normalizeStateUpdateKeys({ '不存在的角色': 'x', sutang: 'y' }, { roleNames: new Map([['苏棠', 'sutang']]), playerName: '怀夕' })
  assert.deepEqual(normalized, { '不存在的角色': 'x', sutang: 'y' })
})

test('id 键与 player 键原样通过', () => {
  const normalized = normalizeStateUpdateKeys({ sutang: 'a', player: 'b' }, { roleNames: new Map([['苏棠', 'sutang']]), playerName: '怀夕' })
  assert.deepEqual(normalized, { sutang: 'a', player: 'b' })
})
