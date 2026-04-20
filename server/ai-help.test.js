const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkillsText } = require('./ai-help');

test('buildSkillsText includes copy-ready token/browserId setup and core endpoint specs', () => {
  const text = buildSkillsText('http://127.0.0.1:3000', '123456', 'demo-browser');

  assert.match(text, /## Connection/);
  assert.match(text, /## AI Action Loop/);
  assert.match(text, /Current token \(plain text\): `123456`/);
  assert.match(text, /Current browserId: `demo-browser`/);
  assert.match(text, /Authorization: Bearer 123456/);
  assert.match(text, /http:\/\/127\.0\.0\.1:3000\/api\/mcp\/demo-browser\/screenshot\?token=123456/);
  assert.match(text, /http:\/\/127\.0\.0\.1:3000\/api\/mcp\/demo-browser\/tablist\?token=123456/);
  assert.match(text, /http:\/\/127\.0\.0\.1:3000\/api\/mcp\/demo-browser\/devtools\?token=123456/);
  assert.match(text, /debugger\.stepInto/);
  assert.match(text, /stack traces/i);
  assert.match(text, /Optional\?/);
  assert.match(text, /Returns/);
  assert.match(text, /curl -s "http:\/\/127\.0\.0\.1:3000\/api\/mcp\/demo-browser\/screenshot\?token=123456"/);
});
