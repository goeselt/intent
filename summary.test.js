'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildPullRequestSummary, buildVersionSummary, titleFix } = require('./summary.js')

function commit(sha, message, bumpLevel) {
  return { sha, message, result: { valid: true, bumpLevel, errors: [] } }
}

test('titleFix returns a concrete rename when validation has a suggestion', () => {
  assert.equal(titleFix({ suggestion: 'feat: add login' }), 'Rename the PR title to `feat: add login`.')
})

test('buildPullRequestSummary explains a bump conflict and marks the commit', () => {
  const summary = buildPullRequestSummary({
    title: 'fix: release',
    titleResult: { valid: true, bumpLevel: 'patch', errors: [] },
    commitAnalysis: [commit('abcdef123456', 'feat!: remove endpoint', 'major')],
    maxCommitBump: 'major',
    commentStatus: 'updated',
  })

  assert.match(summary, /Result:\*\* fail - bump conflict/)
  assert.match(summary, /How to fix/)
  assert.match(summary, /abcdef1/)
  assert.match(summary, /major \(conflict\)/)
  assert.match(summary, /PR comment:\*\* updated/)
})

test('buildPullRequestSummary truncates long commit tables', () => {
  const commits = Array.from({ length: 26 }, (_, i) => commit(String(i).padStart(40, '0'), 'fix: bug', 'patch'))
  const summary = buildPullRequestSummary({
    title: 'fix: release',
    titleResult: { valid: true, bumpLevel: 'patch', errors: [] },
    commitAnalysis: commits,
    maxCommitBump: 'patch',
    commentStatus: 'not needed',
  })

  assert.match(summary, /1 more commits/)
})

test('buildVersionSummary shows the resolved release plan', () => {
  const summary = buildVersionSummary({
    releaseNeeded: true,
    bumpLevel: 'minor',
    currentVersion: '1.2.3',
    nextVersion: '1.3.0',
    previousTag: 'v1.2.3',
    releaseTag: 'v1.3.0',
    majorTag: 'v1',
    minorTag: 'v1.3',
  })

  assert.match(summary, /Release needed:\*\* `true`/)
  assert.match(summary, /Current version:\*\* `1\.2\.3`/)
  assert.match(summary, /Release tag:\*\* `v1\.3\.0`/)
})
