const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedAiHelpToken, resolveAiHelpDisplayToken } = require('./ai-help-auth');

test('isAllowedAiHelpToken accepts the configured ai token', () => {
  assert.equal(isAllowedAiHelpToken({
    providedToken: '123456',
    aiToken: '123456',
    browserToken: 'ZknLvnw5'
  }), true);
});

test('isAllowedAiHelpToken accepts the browser api token', () => {
  assert.equal(isAllowedAiHelpToken({
    providedToken: 'ZknLvnw5',
    aiToken: '123456',
    browserToken: 'ZknLvnw5'
  }), true);
});

test('isAllowedAiHelpToken rejects unrelated tokens', () => {
  assert.equal(isAllowedAiHelpToken({
    providedToken: 'wrong-token',
    aiToken: '123456',
    browserToken: 'ZknLvnw5'
  }), false);
});

test('resolveAiHelpDisplayToken prefers the browser api token for browser-specific help', () => {
  assert.equal(resolveAiHelpDisplayToken({
    providedToken: '123456',
    browserToken: 'ZknLvnw5'
  }), 'ZknLvnw5');
});
