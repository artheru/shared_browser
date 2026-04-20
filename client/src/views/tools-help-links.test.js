import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReadSkillsUrl } from './tools-help-links.js'

test('buildReadSkillsUrl uses browser api token when available', () => {
  const result = buildReadSkillsUrl({
    baseUrl: 'http://192.168.0.146:3000',
    browserId: 'baidu-test',
    token: 'ZknLvnw5'
  })

  assert.equal(
    result,
    'http://192.168.0.146:3000/api/ai/help/read-skills?token=ZknLvnw5&browserId=baidu-test'
  )
})

test('buildReadSkillsUrl keeps fallback token placeholder and includes browserId', () => {
  const result = buildReadSkillsUrl({
    baseUrl: 'http://192.168.0.146:3000/',
    browserId: 'baidu-test',
    token: ''
  })

  assert.equal(
    result,
    'http://192.168.0.146:3000/api/ai/help/read-skills?token=%3Cai-token%3E&browserId=baidu-test'
  )
})
