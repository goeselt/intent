'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { describeCommentFailure, escapeCommandValue, runPullRequest } = require('./index.js')
const { MAX_PR_COMMITS } = require('./github.js')

function payload(overrides = {}) {
  return {
    repository: { full_name: 'goeselt/example' },
    pull_request: { number: 123, title: 'fix: correct release' },
    ...overrides,
  }
}

async function silenceStdout(fn) {
  const origWrite = process.stdout.write
  process.stdout.write = () => true
  try {
    return await fn()
  } finally {
    process.stdout.write = origWrite
  }
}

async function captureStdout(fn) {
  const lines = []
  const origWrite = process.stdout.write
  process.stdout.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  try {
    await fn()
  } finally {
    process.stdout.write = origWrite
  }
  return lines.join('')
}

test('escapeCommandValue escapes GitHub workflow command control characters', () => {
  assert.equal(escapeCommandValue('a%b\rc\nd'), 'a%25b%0Dc%0Ad')
})

test('describeCommentFailure adds permission guidance for HTTP 403 responses', () => {
  const err = new Error(
    'GitHub API POST /repos/x/y/issues/1/comments --> HTTP 403: {"message":"Resource not accessible by integration"}',
  )
  assert.match(describeCommentFailure(err), /permission denied/)
  assert.match(describeCommentFailure(err), /pull-requests: write/)
})

test('describeCommentFailure leaves other errors unchanged', () => {
  const err = new Error('GitHub API POST /repos/x/y/issues/1/comments --> HTTP 500: server error')
  assert.equal(
    describeCommentFailure(err),
    'could not post PR comment: GitHub API POST /repos/x/y/issues/1/comments --> HTTP 500: server error',
  )
})

test('runPullRequest fails closed when github-token is missing', async () => {
  await silenceStdout(async () => {
    await assert.rejects(
      () => runPullRequest({ payload: payload(), token: '', postComment: true }),
      /github-token is required/,
    )
  })
})

test('runPullRequest fails closed when GitHub may have truncated PR commits', async () => {
  const commits = Array.from({ length: MAX_PR_COMMITS }, (_, i) => ({
    sha: `${i}`.padStart(40, '0'),
    commit: { message: 'fix: bug' },
  }))
  let commentCalled = false

  await silenceStdout(async () => {
    await assert.rejects(
      () =>
        runPullRequest({
          payload: payload(),
          token: 'token',
          postComment: true,
          getCommits: () => Promise.resolve(commits),
          upsert: () => {
            commentCalled = true
            return Promise.resolve()
          },
        }),
      /truncates commit analysis/,
    )
  })

  assert.equal(commentCalled, false)
})

test('runPullRequest accepts a missing comment permission and warns instead of failing the job', async () => {
  const output = await captureStdout(() =>
    runPullRequest({
      payload: payload(),
      token: 'token',
      postComment: true,
      getCommits: () => Promise.resolve([]),
      upsert: () =>
        Promise.reject(
          new Error(
            'GitHub API POST /repos/x/y/issues/123/comments --> HTTP 403: {"message":"Resource not accessible by integration"}',
          ),
        ),
    }),
  )

  assert.match(output, /::warning title=Intent::could not post PR comment \(permission denied\)/)
  assert.match(output, /pull-requests: write/)
  assert.match(output, /result=pass/)
})
