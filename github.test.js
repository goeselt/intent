'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { commentMatches, request, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } = require('./github.js')
const { GENERATED_FOOTER, GENERATED_HEADER } = require('./comment.js')

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

test('commentMatches requires a bot author and generated signature when the author login is unknown', () => {
  const marker = '<!-- intent -->'
  const signedBody = `${marker}\n\n${GENERATED_HEADER}\n\nbody\n\n${GENERATED_FOOTER}`
  assert.equal(
    commentMatches({ body: signedBody, user: { login: 'github-actions[bot]', type: 'Bot' } }, marker, '', [
      GENERATED_HEADER,
      GENERATED_FOOTER,
    ]),
    true,
  )
  assert.equal(
    commentMatches({ body: signedBody, user: { login: 'alice', type: 'User' } }, marker, '', [
      GENERATED_HEADER,
      GENERATED_FOOTER,
    ]),
    false,
  )
  assert.equal(
    commentMatches({ body: `hello\n${marker}`, user: { login: 'anyone' } }, marker, '', [
      GENERATED_HEADER,
      GENERATED_FOOTER,
    ]),
    false,
  )
  assert.equal(commentMatches({ body: signedBody, user: { login: 'anyone' } }, marker, ''), false)
  assert.equal(commentMatches({ body: 'no marker', user: { login: 'anyone' } }, marker, ''), false)
})

test('request fails when a GitHub API response exceeds the response cap', async (t) => {
  t.mock.method(https, 'request', (...args) => {
    const onResponse = args[1]
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.write = () => {}
    req.end = () => {
      const res = new EventEmitter()
      res.statusCode = 200
      onResponse(res)
      res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1))
    }
    req.destroy = (err) => req.emit('error', err)
    return req
  })

  await assert.rejects(() => request('GET', '/too-large', 'token'), /response exceeded/)
})

test('request fails when a GitHub API call times out', async (t) => {
  t.mock.method(https, 'request', () => {
    const req = new EventEmitter()
    let timeout
    req.setTimeout = (_ms, cb) => {
      timeout = cb
    }
    req.write = () => {}
    req.end = () => timeout()
    req.destroy = (err) => req.emit('error', err)
    return req
  })

  await assert.rejects(() => request('GET', '/slow', 'token'), new RegExp(`timed out after ${REQUEST_TIMEOUT_MS}ms`))
})
