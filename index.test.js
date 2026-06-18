'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  describeCommentFailure,
  describeReservedTagsSkipped,
  escapeCommandValue,
  parseCommentMode,
  runPullRequest,
  setOutput,
  validateTagComponent,
} = require('./index.js')
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

async function withoutStepSummary(fn) {
  const previousSummary = process.env.GITHUB_STEP_SUMMARY
  delete process.env.GITHUB_STEP_SUMMARY
  try {
    return await fn()
  } finally {
    if (previousSummary === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY
    } else {
      process.env.GITHUB_STEP_SUMMARY = previousSummary
    }
  }
}

test('escapeCommandValue escapes GitHub workflow command control characters', () => {
  assert.equal(escapeCommandValue('a%b\rc\nd'), 'a%25b%0Dc%0Ad')
})

test('parseCommentMode accepts legacy booleans and the failures mode', () => {
  assert.equal(parseCommentMode('true'), 'always')
  assert.equal(parseCommentMode(true), 'always')
  assert.equal(parseCommentMode('always'), 'always')
  assert.equal(parseCommentMode('false'), 'never')
  assert.equal(parseCommentMode(false), 'never')
  assert.equal(parseCommentMode('never'), 'never')
  assert.equal(parseCommentMode('failures'), 'failures')
  assert.equal(parseCommentMode('failure'), 'failures')
  assert.throws(() => parseCommentMode('sometimes'), /true, false, or failures/)
})

test('validateTagComponent rejects values that can inject logs or outputs', () => {
  assert.throws(() => validateTagComponent('release-scope', 'tool\nother-output=owned'), /control characters/)
  assert.throws(() => validateTagComponent('tag-prefix', '-v'), /must not start/)
  assert.doesNotThrow(() => validateTagComponent('release-scope', 'tool'))
  assert.doesNotThrow(() => validateTagComponent('tag-prefix', 'v'))
})

test('setOutput uses GitHub multiline output syntax for newline values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-output-'))
  const outputFile = path.join(dir, 'output')
  const previousOutput = process.env.GITHUB_OUTPUT
  process.env.GITHUB_OUTPUT = outputFile

  try {
    setOutput('release-tag', 'x\ninjected-output=owned/v1.0.1')
    const output = fs.readFileSync(outputFile, 'utf8')
    assert.match(output, /^release-tag<<intent_[a-f0-9]+\n/)
    assert.match(output, /x\ninjected-output=owned\/v1\.0\.1\nintent_[a-f0-9]+\n$/)
  } finally {
    if (previousOutput === undefined) {
      delete process.env.GITHUB_OUTPUT
    } else {
      process.env.GITHUB_OUTPUT = previousOutput
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('describeReservedTagsSkipped explains the skipped tags and chosen alternative', () => {
  assert.equal(
    describeReservedTagsSkipped({ reservedTagsSkipped: ['v1.2.3'], releaseTag: 'v1.2.4' }),
    'reserved release tag skipped; using "v1.2.4" instead',
  )
  assert.equal(
    describeReservedTagsSkipped({ reservedTagsSkipped: ['v1.2.3', 'v1.2.4'], releaseTag: 'v1.2.5' }),
    '2 reserved release tags skipped; using "v1.2.5" instead',
  )
  assert.equal(describeReservedTagsSkipped({ reservedTagsSkipped: [], releaseTag: 'v1.2.4' }), '')
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
  const output = await withoutStepSummary(() =>
    captureStdout(() =>
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
    ),
  )

  assert.match(output, /::warning title=Intent::could not post PR comment \(permission denied\)/)
  assert.match(output, /pull-requests: write/)
  assert.match(output, /result=pass/)
})

test('runPullRequest skips successful PR comments in failures mode and writes a step summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-summary-'))
  const summaryFile = path.join(dir, 'summary')
  const previousSummary = process.env.GITHUB_STEP_SUMMARY
  process.env.GITHUB_STEP_SUMMARY = summaryFile
  let commentCalled = false

  try {
    const output = await captureStdout(() =>
      runPullRequest({
        payload: payload(),
        token: 'token',
        postComment: 'failures',
        getCommits: () => Promise.resolve([]),
        upsert: () => {
          commentCalled = true
          return Promise.resolve()
        },
      }),
    )

    assert.equal(commentCalled, false)
    assert.match(output, /comment=skipped reason=pr-comment-failures-pass/)
    assert.match(fs.readFileSync(summaryFile, 'utf8'), /\| Result \| `pass` \|/)
  } finally {
    if (previousSummary === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY
    } else {
      process.env.GITHUB_STEP_SUMMARY = previousSummary
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
