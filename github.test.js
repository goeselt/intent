'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { commentMatches } = require('./github.js')

test('commentMatches only matches marker comments by the authenticated author', () => {
  const marker = '<!-- intent -->'
  assert.equal(
    commentMatches({ body: `hello\n${marker}`, user: { login: 'intent[bot]' } }, marker, 'intent[bot]'),
    true,
  )
  assert.equal(commentMatches({ body: `hello\n${marker}`, user: { login: 'alice' } }, marker, 'intent[bot]'), false)
  assert.equal(commentMatches({ body: 'hello', user: { login: 'intent[bot]' } }, marker, 'intent[bot]'), false)
  assert.equal(commentMatches({ body: `hello\n${marker}` }, marker, 'intent[bot]'), false)
})

test('commentMatches falls back to marker-only when the author login is unknown', () => {
  const marker = '<!-- intent -->'
  assert.equal(commentMatches({ body: `hello\n${marker}`, user: { login: 'anyone' } }, marker, ''), true)
  assert.equal(commentMatches({ body: `hello\n${marker}` }, marker, ''), true)
  assert.equal(commentMatches({ body: 'no marker', user: { login: 'anyone' } }, marker, ''), false)
})
