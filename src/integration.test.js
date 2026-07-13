'use strict'

// Executable behavior catalog: every scenario prints its use case, inputs, and Intent's response
// (PR comment, annotations, action outputs) as test diagnostics, so a reader can follow from the
// test run output how Intent behaves in which situation.
//
// PR-guard scenarios drive the full pull_request flow with in-memory GitHub API fakes (no network).
// Version-resolution scenarios run against a real throwaway local Git repository (no network either):
// runVersion only talks to the git CLI, so a temp directory exercises the entire path from
// `git tag`/`git log` parsing down to the GITHUB_OUTPUT file.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runPullRequest, runVersion } = require('./index.js')

// -- Diagnostics ------------------------------------------------------------------------------------------------------

function diag(t, label, value) {
  t.diagnostic(`${label}: ${value}`)
}

function diagBlock(t, label, text) {
  const block = String(text)
    .split('\n')
    .map((line) => `  | ${line}`)
    .join('\n')
  t.diagnostic(`${label}:\n${block}`)
}

function describeMergeSettings(raw) {
  if (!raw || typeof raw.allow_squash_merge !== 'boolean') {
    return 'unknown -- event payload does not expose repository merge settings'
  }
  const methods = [
    raw.allow_merge_commit && 'merge commit',
    raw.allow_squash_merge && 'squash',
    raw.allow_rebase_merge && 'rebase',
  ]
    .filter(Boolean)
    .join(' + ')
  const squashTitle = raw.squash_merge_commit_title ? `; squash commit title: ${raw.squash_merge_commit_title}` : ''
  return `allowed methods: ${methods}${squashTitle}`
}

// -- Environment and process plumbing ---------------------------------------------------------------------------------

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

// Points GITHUB_OUTPUT at a temp file, silences the step summary, applies extra inputs, and returns
// the outputs file content written by the run.
async function withActionEnv(inputs, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-scenario-env-'))
  const outputFile = path.join(dir, 'output')
  fs.writeFileSync(outputFile, '')
  const names = ['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', ...Object.keys(inputs)]
  const previous = new Map(names.map((name) => [name, process.env[name]]))

  process.env.GITHUB_OUTPUT = outputFile
  delete process.env.GITHUB_STEP_SUMMARY
  Object.assign(process.env, inputs)

  try {
    await fn()
    return fs.readFileSync(outputFile, 'utf8')
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// -- PR guard scenario runner -----------------------------------------------------------------------------------------

async function runPullRequestScenario(
  t,
  { title, commits = [], mergeSettings = null, prComment = 'failures', existingComment = null },
) {
  const commitObjects = commits.map((message, index) => ({
    sha: `c0ffee${index}`.padEnd(40, '0'),
    commit: { message },
  }))
  const exitCodes = []
  t.mock.method(process, 'exit', (code) => {
    exitCodes.push(code)
  })

  let commentBody = null
  let output = ''
  const outputs = await withActionEnv({}, async () => {
    output = await captureStdout(() =>
      runPullRequest({
        payload: {
          repository: { full_name: 'goeselt/example', default_branch: 'main', ...(mergeSettings ?? {}) },
          pull_request: { number: 123, title },
        },
        token: 'test-token',
        postComment: prComment,
        getCommits: () => Promise.resolve(commitObjects),
        getTags: () => Promise.resolve([]),
        getCommitsForBranch: () => Promise.resolve([]),
        findExisting: () => Promise.resolve(existingComment),
        upsert: (_token, _repo, _prNumber, _marker, body) => {
          commentBody = body
          return Promise.resolve()
        },
      }),
    )
  })

  diag(t, 'use-case', 'PR guard -- on: pull_request')
  diag(t, 'merge-settings', describeMergeSettings(mergeSettings))
  diag(t, 'pr-title', JSON.stringify(title))
  if (commits.length === 0) {
    diag(t, 'commits', '(none)')
  }
  for (const message of commits) {
    diag(t, 'commit', JSON.stringify(message))
  }
  if (existingComment) {
    diag(t, 'existing intent comment', 'yes -- left behind by an earlier failing run')
  }

  const verdict = output.match(/result=(?:pass|fail)[^\n]*/)?.[0] ?? 'unknown'
  diag(t, 'verdict', `${verdict}${exitCodes.length > 0 ? ` (exit code ${exitCodes.join(', ')})` : ''}`)
  const outputLine = outputs.trim().split('\n').filter(Boolean).join(' ')
  diag(t, 'outputs', outputLine || '(none)')
  if (commentBody) {
    diagBlock(t, 'pr-comment posted', commentBody)
  } else {
    const reason = output.match(/comment=skipped reason=([^\n]*)/)?.[1] ?? 'not posted'
    diag(t, 'pr-comment', `(none -- ${reason})`)
  }

  return { output, commentBody, exitCodes, outputs }
}

// -- Version resolution helpers ---------------------------------------------------------------------------------------

function hasGit() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function gitIn(dir) {
  return (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function initRepo(dir) {
  const git = gitIn(dir)
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'user.email', 'intent-test@example.invalid'])
  git(['config', 'user.name', 'Intent Test'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'tag.gpgsign', 'false'])
  return git
}

function commitFile(git, dir, file, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), `${message}\n`)
  git(['add', '--all'])
  git(['commit', '--quiet', '-m', message])
}

async function runVersionScenario(t, { execGit, given, inputs = {} }) {
  diag(t, 'use-case', 'version resolution -- on: push (default branch)')
  for (const line of given) {
    diag(t, 'given', line)
  }
  const inputLine = Object.entries(inputs)
    .map(([name, value]) => `${name.replace(/^INPUT_/, '').toLowerCase()}=${JSON.stringify(value)}`)
    .join(' ')
  diag(t, 'inputs', inputLine || '(defaults)')

  const outputs = await withActionEnv(inputs, async () => {
    await captureStdout(() => runVersion({ execGit }))
  })
  diagBlock(t, 'outputs', outputs.trim())
  return outputs
}

// -- PR guard scenarios -----------------------------------------------------------------------------------------------

test('PR guard scenarios (pull_request event)', async (suite) => {
  await suite.test('valid release intent: feat title and matching commit pass with a success comment', async (t) => {
    const { commentBody, exitCodes, outputs } = await runPullRequestScenario(t, {
      title: 'feat: add login',
      commits: ['feat: add login'],
      prComment: 'always',
    })

    assert.deepEqual(exitCodes, [])
    assert.match(outputs, /^release-needed=true$/m)
    assert.match(outputs, /^bump-level=minor$/m)
    assert.match(commentBody, /`minor`/)
    assert.match(commentBody, /\[!TIP\]/)
  })

  await suite.test('invalid title: a non-conventional PR title blocks and explains the expected format', async (t) => {
    const { commentBody, exitCodes } = await runPullRequestScenario(t, {
      title: 'Added login support',
      commits: ['feat: add login'],
    })

    assert.deepEqual(exitCodes, [1])
    assert.match(commentBody, /Invalid PR Title/)
    assert.match(commentBody, /<type>\[scope\]\[!\]: <description>/)
  })

  await suite.test(
    'bump conflict, merge settings unknown: Intent validates the strongest interpretation',
    async (t) => {
      const { commentBody, exitCodes } = await runPullRequestScenario(t, {
        title: 'fix: correct rounding',
        commits: ['feat: add rounding mode'],
      })

      assert.deepEqual(exitCodes, [1])
      assert.match(commentBody, /Release Intent Mismatch/)
      assert.match(commentBody, /\*\*Merge commit \/ rebase merge:\*\*/)
      assert.match(commentBody, /\*\*Squash merge\*\*/)
      assert.match(commentBody, /strongest interpretation/)
      assert.match(commentBody, /How to rewrite a commit message/)
    },
  )

  await suite.test(
    'bump conflict, squash-only repo (PR title): commit subjects cannot reach the default branch',
    async (t) => {
      const { commentBody, exitCodes } = await runPullRequestScenario(t, {
        title: 'fix: correct rounding',
        commits: ['feat: add rounding mode'],
        mergeSettings: {
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
          squash_merge_commit_title: 'PR_TITLE',
        },
      })

      assert.deepEqual(exitCodes, [1])
      assert.match(commentBody, /only allows squash merges/)
      assert.match(commentBody, /will not reach the default branch/)
      assert.doesNotMatch(commentBody, /\*\*Merge commit \/ rebase merge:\*\*/)
    },
  )

  await suite.test('bump conflict, squash-only repo: a BREAKING CHANGE footer survives the squash', async (t) => {
    const { commentBody, exitCodes } = await runPullRequestScenario(t, {
      title: 'fix: adjust config handling',
      commits: ['fix: adjust config handling\n\nBREAKING CHANGE: renamed config keys'],
      mergeSettings: {
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        squash_merge_commit_title: 'PR_TITLE',
      },
    })

    assert.deepEqual(exitCodes, [1])
    assert.match(commentBody, /copied into the squash commit body/)
    assert.match(commentBody, /Remove the footer if the breaking change is not real/)
  })

  await suite.test(
    'bump conflict, merge/rebase repo: commit messages land on the default branch as written',
    async (t) => {
      const { commentBody, exitCodes } = await runPullRequestScenario(t, {
        title: 'fix: correct rounding',
        commits: ['feat: add rounding mode'],
        mergeSettings: {
          allow_squash_merge: false,
          allow_merge_commit: true,
          allow_rebase_merge: true,
          squash_merge_commit_title: '',
        },
      })

      assert.deepEqual(exitCodes, [1])
      assert.match(commentBody, /does not allow squash merges/)
      assert.doesNotMatch(commentBody, /\*\*Squash merge\*\*/)
    },
  )

  await suite.test('squash title risk: a single commit weaker than the title warns but does not block', async (t) => {
    const { commentBody, exitCodes, output } = await runPullRequestScenario(t, {
      title: 'fix!: drop legacy endpoint',
      commits: ['fix: drop legacy endpoint'],
    })

    assert.deepEqual(exitCodes, [])
    assert.match(output, /result=pass/)
    assert.match(commentBody, /### Squash merge warning/)
    assert.match(commentBody, /the only commit in this PR implies `patch`/)
  })

  await suite.test(
    'recovery: a stale failure comment is updated to the resolved state once the check passes',
    async (t) => {
      const { commentBody, exitCodes, output } = await runPullRequestScenario(t, {
        title: 'fix: correct rounding',
        commits: ['fix: correct rounding'],
        existingComment: {
          id: 7,
          body: '<!-- intent -->\n> [!CAUTION]\nRelease Intent Mismatch (from an earlier run)',
        },
      })

      assert.deepEqual(exitCodes, [])
      assert.match(output, /comment=updated reason=resolve-stale-comment/)
      assert.match(commentBody, /sets the intended release to a \*\*`patch`\*\* bump/)
      assert.doesNotMatch(commentBody, /\[!CAUTION\]/)
    },
  )

  await suite.test('quiet pass: without a prior comment, failures mode posts nothing', async (t) => {
    const { commentBody, exitCodes } = await runPullRequestScenario(t, {
      title: 'chore: update dependencies',
      commits: ['chore: update dependencies'],
    })

    assert.deepEqual(exitCodes, [])
    assert.equal(commentBody, null)
  })
})

// -- Version resolution scenarios ---------------------------------------------------------------------------------------

test('version resolution scenarios (on: push, real local Git repository)', { skip: !hasGit() }, async (suite) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-scenario-repo-'))
  const git = initRepo(dir)
  const execGit = gitIn(dir)
  suite.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await suite.test('first release: a feat commit and no tags resolve 0.1.0', async (t) => {
    commitFile(git, dir, 'lib.txt', 'feat: first feature')
    const outputs = await runVersionScenario(t, {
      execGit,
      given: ['tags: (none)', 'commit: feat: first feature'],
    })

    assert.match(outputs, /^release-needed=true$/m)
    assert.match(outputs, /^next-version=0\.1\.0$/m)
    assert.match(outputs, /^release-tag=v0\.1\.0$/m)
    assert.match(outputs, /^previous-tag=$/m)
  })

  await suite.test('hidden breaking change: a BREAKING CHANGE footer outranks the fix subject', async (t) => {
    git(['tag', 'v0.1.0'])
    commitFile(git, dir, 'lib.txt', 'fix: change format\n\nBREAKING CHANGE: config format changed')
    const outputs = await runVersionScenario(t, {
      execGit,
      given: ['tags: v0.1.0', 'commit: fix: change format -- with footer: BREAKING CHANGE: config format changed'],
    })

    assert.match(outputs, /^bump-level=major$/m)
    assert.match(outputs, /^next-version=1\.0\.0$/m)
    assert.match(outputs, /^previous-tag=v0\.1\.0$/m)
  })

  await suite.test('ignored paths: documentation-only changes do not release', async (t) => {
    git(['tag', 'v1.0.0'])
    commitFile(git, dir, 'docs/readme.txt', 'feat: document everything')
    const outputs = await runVersionScenario(t, {
      execGit,
      given: ['tags: v0.1.0, v1.0.0', 'commit: feat: document everything -- touches docs/ only'],
      inputs: { 'INPUT_RELEASE-IGNORE-PATHS': 'docs/' },
    })

    assert.match(outputs, /^release-needed=false$/m)
    assert.match(outputs, /^current-version=1\.0\.0$/m)
  })

  await suite.test('tag selection: the highest version wins even when an older tag was created later', async (t) => {
    git(['tag', 'v0.9.0'])
    commitFile(git, dir, 'lib.txt', 'fix: small bug')
    const outputs = await runVersionScenario(t, {
      execGit,
      given: ['tags: v0.1.0, v1.0.0, v0.9.0 (v0.9.0 created after v1.0.0)', 'commit: fix: small bug'],
      inputs: { 'INPUT_RELEASE-IGNORE-PATHS': 'docs/' },
    })

    assert.match(outputs, /^previous-tag=v1\.0\.0$/m)
    assert.match(outputs, /^next-version=1\.0\.1$/m)
  })
})

test('scoped release scenario (monorepo, real local Git repository)', { skip: !hasGit() }, async (suite) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-scenario-scoped-'))
  const git = initRepo(dir)
  suite.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await suite.test('release-scope cli: tags and floating tags live in the cli/ namespace', async (t) => {
    commitFile(git, dir, 'cmd/cli/main.txt', 'feat: add cli command')
    const outputs = await runVersionScenario(t, {
      execGit: gitIn(dir),
      given: ['tags: (none)', 'commit: feat: add cli command'],
      inputs: { 'INPUT_RELEASE-SCOPE': 'cli' },
    })

    assert.match(outputs, /^release-tag=cli\/v0\.1\.0$/m)
    assert.match(outputs, /^major-tag=cli\/v0$/m)
    assert.match(outputs, /^minor-tag=cli\/v0\.1$/m)
    assert.match(outputs, /^next-version=0\.1\.0$/m)
  })
})

test('shallow clone scenario (real local Git repository)', { skip: !hasGit() }, async (suite) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-scenario-shallow-'))
  const sourceDir = path.join(dir, 'source')
  const cloneDir = path.join(dir, 'clone')
  fs.mkdirSync(sourceDir)
  suite.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await suite.test('a shallow checkout is rejected instead of resolving a wrong version', async (t) => {
    const git = initRepo(sourceDir)
    commitFile(git, sourceDir, 'lib.txt', 'feat: first feature')
    commitFile(git, sourceDir, 'lib.txt', 'fix: second commit')
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${sourceDir}`, cloneDir], { encoding: 'utf8' })

    diag(t, 'use-case', 'version resolution -- on: push, checkout with fetch-depth: 1')
    diag(t, 'given', 'shallow clone: tags and history may be missing')

    await withActionEnv({}, async () => {
      await captureStdout(() => {
        assert.throws(() => runVersion({ execGit: gitIn(cloneDir) }), /fetch-depth: 0/)
      })
    })
    diag(t, 'verdict', 'run fails fast with guidance to use actions/checkout fetch-depth: 0')
  })
})
