'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  assertGitHistory,
  describeCommentFailure,
  describeReservedTagsSkipped,
  escapeCommandValue,
  parseCommentMode,
  repoMergeSettings,
  runPullRequest,
  runVersion,
  setOutput,
  validatePRNumber,
  validateRepoFullName,
  validateTagComponent,
} = require('./index.js')
const { MAX_PR_COMMITS } = require('./github.js')

function payload(overrides = {}) {
  return {
    repository: { full_name: 'goeselt/example', default_branch: 'main' },
    pull_request: { number: 123, title: 'fix: correct release' },
    ...overrides,
  }
}

function noReleaseContext() {
  return {
    getTags: () => Promise.resolve([]),
    getCommitsForBranch: () => Promise.resolve([]),
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
  assert.throws(() => parseCommentMode('sometimes'), /failures, true, always, false, never/)
})

test('validateTagComponent rejects values that can inject logs or outputs', () => {
  assert.throws(() => validateTagComponent('release-scope', 'tool\nother-output=owned'), /control characters/)
  assert.throws(() => validateTagComponent('tag-prefix', '-v'), /must not start/)
  assert.doesNotThrow(() => validateTagComponent('release-scope', 'tool'))
  assert.doesNotThrow(() => validateTagComponent('tag-prefix', 'v'))
})

test('validateRepoFullName accepts owner/repo and rejects path-like values', () => {
  assert.doesNotThrow(() => validateRepoFullName('goeselt/example'))
  assert.doesNotThrow(() => validateRepoFullName('my-org/my.repo_1'))
  assert.throws(() => validateRepoFullName('goeselt'), /owner\/repo/)
  assert.throws(() => validateRepoFullName('goeselt/example/../other'), /owner\/repo/)
  assert.throws(() => validateRepoFullName('goeselt/example?per_page=1'), /owner\/repo/)
})

test('validatePRNumber accepts only positive integers', () => {
  assert.doesNotThrow(() => validatePRNumber(123))
  assert.throws(() => validatePRNumber(0), /positive integer/)
  assert.throws(() => validatePRNumber(-1), /positive integer/)
  assert.throws(() => validatePRNumber('123/comments'), /positive integer/)
  assert.throws(() => validatePRNumber(), /positive integer/)
})

test('assertGitHistory fails with checkout guidance when git has no repository', () => {
  const execGit = () => {
    throw new Error('fatal: not a git repository (or any of the parent directories): .git')
  }
  assert.throws(() => assertGitHistory(execGit), /run actions\/checkout first/)
})

test('assertGitHistory fails with fetch-depth guidance on shallow clones', () => {
  const execGit = () => 'true\n'
  assert.throws(() => assertGitHistory(execGit), /fetch-depth: 0/)
})

test('assertGitHistory accepts a full clone', () => {
  const execGit = () => 'false\n'
  assert.doesNotThrow(() => assertGitHistory(execGit))
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

test('describeCommentFailure adds token guidance for HTTP 401 responses', () => {
  const err = new Error('GitHub API POST /repos/x/y/issues/1/comments --> HTTP 401: {"message":"Bad credentials"}')
  assert.match(describeCommentFailure(err), /authentication failed/)
  assert.match(describeCommentFailure(err), /github-token/)
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

test('repoMergeSettings reads best-effort merge settings from the event payload', () => {
  assert.equal(repoMergeSettings({}), null)
  assert.equal(repoMergeSettings({ repository: { full_name: 'a/b' } }), null)

  assert.deepEqual(
    repoMergeSettings({
      repository: {
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        squash_merge_commit_title: 'PR_TITLE',
      },
    }),
    { allowSquashMerge: true, allowMergeCommit: false, allowRebaseMerge: false, squashCommitTitle: 'PR_TITLE' },
  )

  // Falls back to the base repository object and rejects non-enum squash title values.
  assert.deepEqual(
    repoMergeSettings({
      repository: { full_name: 'a/b' },
      pull_request: {
        base: { repo: { allow_squash_merge: false, allow_merge_commit: true, squash_merge_commit_title: '::evil' } },
      },
    }),
    { allowSquashMerge: false, allowMergeCommit: true, allowRebaseMerge: false, squashCommitTitle: '' },
  )
})

test('runPullRequest tailors the conflict comment to payload merge settings', async (t) => {
  // The conflict path ends in process.exit(1); neutralize it so the test process survives.
  const exitCodes = []
  t.mock.method(process, 'exit', (code) => {
    exitCodes.push(code)
  })
  let commentBody = ''

  const output = await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload({
          repository: {
            full_name: 'goeselt/example',
            default_branch: 'main',
            allow_squash_merge: true,
            allow_merge_commit: false,
            allow_rebase_merge: false,
            squash_merge_commit_title: 'PR_TITLE',
          },
          pull_request: { number: 123, title: 'fix: correct release' },
        }),
        token: 'token',
        postComment: 'failures',
        getCommits: () => Promise.resolve([{ sha: 'abc123456789', commit: { message: 'feat: new thing' } }]),
        ...noReleaseContext(),
        upsert: (_token, _repo, _prNumber, _marker, body) => {
          commentBody = body
          return Promise.resolve()
        },
      }),
    ),
  )

  assert.deepEqual(exitCodes, [1])
  assert.match(output, /result=fail reason=bump-conflict/)
  assert.match(output, /merge-settings squash=true merge=false rebase=false squash-title=PR_TITLE/)
  assert.match(commentBody, /only allows squash merges/)
  assert.match(commentBody, /will not reach the default branch/)
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
        ...noReleaseContext(),
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
        ...noReleaseContext(),
        findExisting: () => Promise.resolve(null),
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

test('runPullRequest resolves a stale failure comment once the check passes in failures mode', async () => {
  let commentBody = ''

  const output = await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload(),
        token: 'token',
        postComment: 'failures',
        getCommits: () => Promise.resolve([]),
        ...noReleaseContext(),
        findExisting: () => Promise.resolve({ id: 7, body: '<!-- intent -->\n> [!CAUTION]\nold failure' }),
        upsert: (_token, _repo, _prNumber, _marker, body) => {
          commentBody = body
          return Promise.resolve()
        },
      }),
    ),
  )

  assert.match(output, /comment=updated reason=resolve-stale-comment/)
  assert.match(output, /result=pass/)
  assert.match(commentBody, /sets the intended release to a \*\*`patch`\*\* bump/)
  assert.ok(!commentBody.includes('[!CAUTION]'), 'resolved comment must not keep the failure alert')
})

test('runPullRequest leaves an already-resolved comment untouched in failures mode', async () => {
  let commentCalled = false

  const output = await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload(),
        token: 'token',
        postComment: 'failures',
        getCommits: () => Promise.resolve([]),
        ...noReleaseContext(),
        findExisting: () => Promise.resolve({ id: 7, body: '<!-- intent -->\n> [!NOTE]\nall good' }),
        upsert: () => {
          commentCalled = true
          return Promise.resolve()
        },
      }),
    ),
  )

  assert.equal(commentCalled, false)
  assert.match(output, /comment=skipped reason=pr-comment-failures-pass/)
})

test('runPullRequest degrades quietly when the stale-comment lookup fails', async () => {
  const output = await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload(),
        token: 'token',
        postComment: 'failures',
        getCommits: () => Promise.resolve([]),
        ...noReleaseContext(),
        findExisting: () => Promise.reject(new Error('GitHub API GET /repos/x/y --> HTTP 403: forbidden')),
        upsert: () => Promise.resolve(),
      }),
    ),
  )

  assert.match(output, /comment=refresh-skipped/)
  assert.match(output, /result=pass/)
  assert.ok(!output.includes('::warning'), 'best-effort refresh must not warn')
})

test('runPullRequest comments and warns when a single commit could drop the PR title bump', async () => {
  let commentBody = ''

  const output = await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload({ pull_request: { number: 123, title: 'fix!: update storefront representation' } }),
        token: 'token',
        postComment: 'failures',
        getCommits: () =>
          Promise.resolve([
            {
              sha: 'abc123456789',
              commit: { message: 'fix: update storefront representation' },
            },
          ]),
        ...noReleaseContext(),
        upsert: (_token, _repo, _prNumber, _marker, body) => {
          commentBody = body
          return Promise.resolve()
        },
      }),
    ),
  )

  assert.match(output, /::warning title=Intent::PR title signals major/)
  assert.match(output, /squash-title-warning=true/)
  assert.match(output, /comment=updated/)
  assert.match(output, /result=pass/)
  assert.match(commentBody, /### Squash merge warning/)
  assert.match(commentBody, /PR title declares a `major` bump/)
  assert.match(commentBody, /only commit in this PR implies `patch`/)
})

test('runPullRequest adds release context to the PR comment', async () => {
  let commentBody = ''
  let comparedBase = ''

  await withoutStepSummary(() =>
    captureStdout(() =>
      runPullRequest({
        payload: payload({ pull_request: { number: 123, title: 'feat!: remove legacy API' } }),
        token: 'token',
        postComment: 'always',
        getCommits: () => Promise.resolve([]),
        getTags: () => Promise.resolve([{ name: 'v1.2.0' }, { name: 'v1.10.0' }, { name: 'not-a-release' }]),
        compare: (_token, _repo, base) => {
          comparedBase = base
          return Promise.resolve([{ commit: { message: 'feat: existing default branch feature' } }])
        },
        upsert: (_token, _repo, _prNumber, _marker, body) => {
          commentBody = body
          return Promise.resolve()
        },
      }),
    ),
  )

  assert.equal(comparedBase, 'v1.10.0')
  assert.match(commentBody, /### Release context/)
  assert.match(commentBody, /The default branch already requires a `minor` bump\./)
  assert.match(commentBody, /This PR would raise the next release to `major`\./)
})

test('runPullRequest rejects a malformed repository full name before any API call', async () => {
  let apiCalled = false
  await silenceStdout(async () => {
    await assert.rejects(
      () =>
        runPullRequest({
          payload: payload({ repository: { full_name: 'goeselt/example/../evil', default_branch: 'main' } }),
          token: 'token',
          getCommits: () => {
            apiCalled = true
            return Promise.resolve([])
          },
        }),
      /owner\/repo/,
    )
  })
  assert.equal(apiCalled, false)
})

test('runPullRequest rejects a non-integer PR number before any API call', async () => {
  let apiCalled = false
  await silenceStdout(async () => {
    await assert.rejects(
      () =>
        runPullRequest({
          payload: payload({ pull_request: { number: '123/comments', title: 'fix: correct release' } }),
          token: 'token',
          getCommits: () => {
            apiCalled = true
            return Promise.resolve([])
          },
        }),
      /positive integer/,
    )
  })
  assert.equal(apiCalled, false)
})

function fakeVersionGit({ shallow = 'false', tags = 'v1.2.3\nv1.2.0\n', log = '\x00feat: add thing\x00' } = {}) {
  return (args) => {
    if (args[0] === 'rev-parse') return `${shallow}\n`
    if (args[0] === 'tag') return tags
    if (args[0] === 'log') return log
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
}

test('runVersion resolves the next version from tags and commit history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-version-'))
  const outputFile = path.join(dir, 'output')
  const previousOutput = process.env.GITHUB_OUTPUT
  process.env.GITHUB_OUTPUT = outputFile

  try {
    const output = await withoutStepSummary(() => captureStdout(() => runVersion({ execGit: fakeVersionGit() })))

    assert.match(output, /result=pass release-needed=true bump=minor current=1\.2\.3 next=1\.3\.0/)
    const written = fs.readFileSync(outputFile, 'utf8')
    assert.match(written, /^release-needed=true$/m)
    assert.match(written, /^next-version=1\.3\.0$/m)
    assert.match(written, /^release-tag=v1\.3\.0$/m)
    assert.match(written, /^previous-tag=v1\.2\.3$/m)
  } finally {
    if (previousOutput === undefined) {
      delete process.env.GITHUB_OUTPUT
    } else {
      process.env.GITHUB_OUTPUT = previousOutput
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runVersion fails fast on a shallow clone instead of resolving a wrong version', async () => {
  let versionGitCalled = false
  const execGit = (args) => {
    if (args[0] === 'rev-parse') return 'true\n'
    versionGitCalled = true
    return ''
  }

  await silenceStdout(() => assert.throws(() => runVersion({ execGit }), /fetch-depth: 0/))
  assert.equal(versionGitCalled, false)
})
