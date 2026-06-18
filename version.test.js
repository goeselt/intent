'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  analyzeCommit,
  applyBump,
  buildLogArgs,
  buildReleasePathspecs,
  extractVersion,
  findLatestTag,
  formatTags,
  maxBump,
  parseCommitLog,
  parsePaths,
  parseReservedTags,
  parseSemver,
  resolveVersion,
  validate,
} = require('./version.js')

test('analyzeCommit maps conventional commits to bump levels', () => {
  const cases = [
    ['feat: add login', 'minor'],
    ['fix: resolve crash', 'patch'],
    ['perf: speed up query', 'patch'],
    ['feat(api)!: drop legacy endpoint', 'major'],
    ['fix: update\n\nBREAKING CHANGE: new format', 'major'],
    ['fix: update\n\nBREAKING-CHANGE: new format', 'major'],
    ['docs: update readme', 'none'],
    ['chore: update deps', 'none'],
    ['feature: add alias support', 'none'],
    ['FEAT: add uppercase type', 'none'],
    ['just a message', 'none'],
    ['feat:', 'none'],
    ['', 'none'],
  ]

  for (const [message, expected] of cases) {
    assert.equal(analyzeCommit(message).bumpLevel, expected, message)
  }
})

test('validate rejects non-canonical aliases as unknown types', () => {
  assert.deepEqual(validate('feature: add login'), {
    valid: false,
    bumpLevel: null,
    errors: [
      'unknown type "feature"',
      'allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test',
    ],
  })
})

test('validate accepts only canonical PR titles', () => {
  assert.deepEqual(validate('feat(auth)!: remove legacy login'), {
    valid: true,
    bumpLevel: 'major',
    errors: [],
  })
})

test('validate rejects uppercase conventional commit types', () => {
  assert.deepEqual(validate('FEAT: add login'), {
    valid: false,
    bumpLevel: null,
    errors: [
      'title does not match <type>[scope][!]: <description>',
      'got: FEAT: add login',
      'allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test',
    ],
  })
})

test('maxBump returns the highest bump', () => {
  assert.equal(maxBump(['fix: bug', 'feat: add', 'docs: readme']), 'minor')
  assert.equal(maxBump(['fix: bug', 'feat!: break']), 'major')
  assert.equal(maxBump(['docs: readme']), 'none')
})

test('parseSemver accepts only strict major.minor.patch versions', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3])
  assert.throws(() => parseSemver('1.2'), /invalid semantic version/)
  assert.throws(() => parseSemver('v1.2.3'), /invalid semantic version/)
  assert.throws(() => parseSemver('01.2.3'), /invalid semantic version/)
  assert.throws(() => parseSemver('9007199254740992.0.0'), /too large/)
})

test('applyBump increments semantic versions', () => {
  assert.equal(applyBump('1.2.3', 'major'), '2.0.0')
  assert.equal(applyBump('1.2.3', 'minor'), '1.3.0')
  assert.equal(applyBump('1.2.3', 'patch'), '1.2.4')
  assert.equal(applyBump('1.2.3', 'none'), '1.2.3')
})

test('findLatestTag returns first matching stable semver tag', () => {
  assert.equal(findLatestTag('v2.0.0\nv1.0.0\n', '', 'v'), 'v2.0.0')
  assert.equal(findLatestTag('tool/v1.2.0\ntool/v1.1.0\n', 'tool', 'v'), 'tool/v1.2.0')
  assert.equal(findLatestTag('v2.0.0-beta\nv1.0.0\n', '', 'v'), 'v1.0.0')
  assert.equal(findLatestTag('v9007199254740992.0.0\nv1.0.0\n', '', 'v'), 'v1.0.0')
  assert.equal(findLatestTag('1.2.0\n1.1.0\n', '', ''), '1.2.0')
  assert.equal(findLatestTag('other\n', '', 'v'), '')
})

test('extractVersion strips scope and prefix', () => {
  assert.equal(extractVersion('v1.2.3', '', 'v'), '1.2.3')
  assert.equal(extractVersion('tool/v1.2.3', 'tool', 'v'), '1.2.3')
  assert.equal(extractVersion('1.2.3', '', ''), '1.2.3')
})

test('formatTags formats release and floating tags', () => {
  assert.deepEqual(formatTags('1.2.3', '', 'v'), {
    releaseTag: 'v1.2.3',
    majorTag: 'v1',
    minorTag: 'v1.2',
  })
  assert.deepEqual(formatTags('1.2.3', 'tool', 'v'), {
    releaseTag: 'tool/v1.2.3',
    majorTag: 'tool/v1',
    minorTag: 'tool/v1.2',
  })
})

test('parseCommitLog reads nul-delimited git log output', () => {
  assert.deepEqual(parseCommitLog('\x00feat: add\x00fix: bug\n\x00'), ['feat: add', 'fix: bug'])
})

test('parsePaths trims newline-separated path filters', () => {
  assert.deepEqual(parsePaths('src/\n\n docs/readme.md \n'), ['src/', 'docs/readme.md'])
})

test('parseReservedTags accepts comma, whitespace, and newline separated release tags', () => {
  assert.deepEqual(parseReservedTags('v1.2.3, v1.2.4\nv1.2.4 v1.2.5'), ['v1.2.3', 'v1.2.4', 'v1.2.5'])
})

test('parseReservedTags validates tags against the configured release namespace', () => {
  assert.deepEqual(parseReservedTags('cli/v1.2.3', { scope: 'cli', prefix: 'v' }), ['cli/v1.2.3'])
  assert.throws(() => parseReservedTags('v1.2.3', { scope: 'cli', prefix: 'v' }), /cli\/v<major\.minor\.patch>/)
  assert.throws(() => parseReservedTags('v1.2', { prefix: 'v' }), /v<major\.minor\.patch>/)
  assert.throws(() => parseReservedTags('not-a-version', { prefix: 'v' }), /v<major\.minor\.patch>/)
})

test('buildReleasePathspecs combines include and ignore path filters', () => {
  assert.deepEqual(buildReleasePathspecs(['src/', 'package.json'], ['docs/']), [
    'src/',
    'package.json',
    ':(exclude)docs/',
  ])
})

test('buildReleasePathspecs adds root path when only ignore filters are configured', () => {
  assert.deepEqual(buildReleasePathspecs([], ['docs/', 'README.md']), ['.', ':(exclude)docs/', ':(exclude)README.md'])
})

test('buildReleasePathspecs returns empty list when no filters are configured', () => {
  assert.deepEqual(buildReleasePathspecs([], []), [])
})

test('buildLogArgs scopes to HEAD (never --all) when there is no previous tag', () => {
  assert.deepEqual(buildLogArgs('', []), ['log', '--format=%x00%B', 'HEAD'])
})

test('buildLogArgs uses the previousTag..HEAD range when a tag exists', () => {
  assert.deepEqual(buildLogArgs('v1.2.3', []), ['log', '--format=%x00%B', 'v1.2.3..HEAD'])
})

test('buildLogArgs appends pathspecs after a -- separator', () => {
  assert.deepEqual(buildLogArgs('v1.2.3', ['src/', ':(exclude)docs/']), [
    'log',
    '--format=%x00%B',
    'v1.2.3..HEAD',
    '--',
    'src/',
    ':(exclude)docs/',
  ])
})

test('resolveVersion combines tags and commits into action outputs', () => {
  assert.deepEqual(
    resolveVersion({
      initialVersion: '0.0.0',
      tagOutput: 'v1.2.3\nv1.2.0\n',
      commitMessages: ['fix: bug'],
      scope: '',
      prefix: 'v',
    }),
    {
      releaseNeeded: true,
      bumpLevel: 'patch',
      currentVersion: '1.2.3',
      nextVersion: '1.2.4',
      previousTag: 'v1.2.3',
      reservedTagsSkipped: [],
      releaseTag: 'v1.2.4',
      majorTag: 'v1',
      minorTag: 'v1.2',
    },
  )
})

test('resolveVersion keeps current version when there is no release bump', () => {
  const result = resolveVersion({
    initialVersion: '0.0.0',
    tagOutput: 'v1.2.3\n',
    commitMessages: ['docs: readme'],
  })
  assert.equal(result.releaseNeeded, false)
  assert.equal(result.bumpLevel, 'none')
  assert.equal(result.nextVersion, '1.2.3')
})

test('resolveVersion skips reserved release tags and uses the next patch alternative', () => {
  assert.deepEqual(
    resolveVersion({
      initialVersion: '0.0.0',
      tagOutput: 'v1.2.2\n',
      commitMessages: ['fix: bug'],
      reservedTags: ['v1.2.3', 'v1.2.4'],
    }),
    {
      releaseNeeded: true,
      bumpLevel: 'patch',
      currentVersion: '1.2.2',
      nextVersion: '1.2.5',
      previousTag: 'v1.2.2',
      reservedTagsSkipped: ['v1.2.3', 'v1.2.4'],
      releaseTag: 'v1.2.5',
      majorTag: 'v1',
      minorTag: 'v1.2',
    },
  )
})
