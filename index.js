'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { buildComment, GENERATED_FOOTER, GENERATED_HEADER, MARKER } = require('./comment.js')
const {
  compareCommits,
  getBranchCommits,
  getPRCommits,
  getRepositoryTags,
  upsertComment,
  MAX_PR_COMMITS,
} = require('./github.js')
const { buildPullRequestSummary, buildVersionSummary, titleFix } = require('./summary.js')
const {
  analyzeCommit,
  buildLogArgs,
  buildReleasePathspecs,
  bumpGt,
  findLatestTag,
  firstLine,
  maxBump,
  parseCommitLog,
  parsePaths,
  parseReservedTags,
  parseSemver,
  resolveVersion,
  validate,
} = require('./version.js')

// --- Logging and workflow commands -----------------------------------------------------------------------------------

// Diagnostic markers. Narrative lines carry a greppable `[intent]` prefix;
// problems use GitHub workflow-command annotations (which also carry `Intent` so they stay greppable).
// Every run ends with a single `result=pass|fail` line so a reader can find the verdict fast.
function log(message) {
  process.stdout.write(`[intent] ${message}\n`)
}

function escapeCommandValue(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

function warn(message) {
  process.stdout.write(`::warning title=Intent::${escapeCommandValue(message)}\n`)
}

function fail(message) {
  process.stdout.write(`::error title=Intent::${escapeCommandValue(message)}\n`)
}

// A 403 from the comment endpoints almost always means the job's GITHUB_TOKEN lacks the `pull-requests: write`
// permission -- the single most common cause, and the one actionable from the workflow file alone.
function describeCommentFailure(err) {
  if (/HTTP 403/.test(err.message)) {
    return `could not post PR comment (permission denied): ${err.message} -- grant "pull-requests: write" permission to this job`
  }
  return `could not post PR comment: ${err.message}`
}

// --- Inputs, files, and shell boundaries -----------------------------------------------------------------------------

function input(name, fallback = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback
}

function commentModeInput(name, fallback = 'failures') {
  return parseCommentMode(input(name, fallback))
}

function parseCommentMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()

  if (raw === 'true' || raw === 'always') return 'always'
  if (raw === 'false' || raw === 'never') return 'never'
  if (raw === 'failure' || raw === 'failures') return 'failures'
  throw new Error(`pr-comment must be true, false, or failures, got ${JSON.stringify(raw)}`)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function eventPayload() {
  const eventPath = process.env['GITHUB_EVENT_PATH']
  if (!eventPath) return {}
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'))
}

function isPREvent(eventName) {
  return eventName === 'pull_request' || eventName === 'pull_request_target'
}

function setOutput(name, value) {
  const outputFile = process.env['GITHUB_OUTPUT']
  if (!outputFile) return
  const text = String(value ?? '')
  if (!/[\r\n]/.test(text)) {
    fs.appendFileSync(outputFile, `${name}=${text}\n`)
    return
  }

  const delimiter = `intent_${crypto.randomUUID().replace(/-/g, '')}`
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${text}\n${delimiter}\n`)
}

function writeVersionOutputs(result) {
  setOutput('release-needed', String(result.releaseNeeded))
  setOutput('bump-level', result.bumpLevel)
  setOutput('current-version', result.currentVersion)
  setOutput('next-version', result.nextVersion)
  setOutput('previous-tag', result.previousTag)
  setOutput('release-tag', result.releaseTag)
  setOutput('major-tag', result.majorTag)
  setOutput('minor-tag', result.minorTag)
  setOutput('major-version', result.majorVersion)
  setOutput('minor-version', result.minorVersion)
}

function describeReservedTagsSkipped(result) {
  const skipped = result.reservedTagsSkipped ?? []
  if (skipped.length === 0) return ''

  const prefix =
    skipped.length === 1 ? 'reserved release tag skipped' : `${skipped.length} reserved release tags skipped`
  return `${prefix}; using ${JSON.stringify(result.releaseTag)} instead`
}

function releaseTagBase(scope, prefix) {
  return scope ? `${scope}/${prefix}` : prefix
}

function latestReleaseTag(tags, scope, prefix) {
  const base = releaseTagBase(scope, prefix)
  const candidates = []

  for (const tag of tags) {
    const name = String(tag?.name ?? '')
    if (!name.startsWith(base)) continue

    const version = name.slice(base.length)
    try {
      candidates.push({ name, version: parseSemver(version) })
    } catch {
      // Ignore non-semver tags in the same namespace, matching push-mode behaviour.
    }
  }

  candidates.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i]
    }
    return 0
  })

  return candidates[0]?.name ?? ''
}

async function resolvePullRequestReleaseContext({
  token,
  repo,
  defaultBranch,
  scope = '',
  prefix = 'v',
  getTags = getRepositoryTags,
  compare = compareCommits,
  getCommitsForBranch = getBranchCommits,
}) {
  if (!defaultBranch) return null

  const tags = await getTags(token, repo)
  const previousTag = latestReleaseTag(tags, scope, prefix)
  const commits = previousTag
    ? await compare(token, repo, previousTag, defaultBranch)
    : await getCommitsForBranch(token, repo, defaultBranch)
  const commitMessages = commits
    .map((commit) => commit?.commit?.message)
    .filter((message) => typeof message === 'string')
  const defaultBranchBump = maxBump(commitMessages)

  log(
    `release-context default-branch=${defaultBranch} previous-tag=${previousTag || '-'} commits-analyzed=${commitMessages.length} bump=${defaultBranchBump}`,
  )

  return { defaultBranchBump }
}

function appendStepSummary(content) {
  const summaryFile = process.env['GITHUB_STEP_SUMMARY']
  if (!summaryFile) return
  fs.appendFileSync(summaryFile, `${content.trimEnd()}\n`)
}

// --- Modes -----------------------------------------------------------------------------------------------------------

async function runPullRequest({
  payload,
  token,
  postComment = 'failures',
  getCommits = getPRCommits,
  getTags = getRepositoryTags,
  compare = compareCommits,
  getCommitsForBranch = getBranchCommits,
  upsert = upsertComment,
  releaseScope = '',
  tagPrefix = 'v',
}) {
  const pr = payload.pull_request
  if (!pr) throw new Error('pull_request payload is missing')

  const repo = payload.repository?.full_name
  if (!repo) throw new Error('repository.full_name is missing from event payload')

  const title = pr.title ?? ''
  const prNumber = pr.number
  const defaultBranch = payload.repository?.default_branch ?? pr.base?.repo?.default_branch ?? pr.base?.ref ?? ''
  const titleResult = validate(title)
  const commentMode = parseCommentMode(postComment)

  log(`mode=pull-request repository=${repo} pr=${prNumber} pr-comment=${commentMode}`)
  log(`pr-title=${JSON.stringify(title)}`)
  log(`title-valid=${titleResult.valid} title-bump=${titleResult.bumpLevel ?? '-'}`)

  if (!token) {
    throw new Error('github-token is required for pull_request validation')
  }

  const commits = await getCommits(token, repo, prNumber)
  if (commits.length >= MAX_PR_COMMITS) {
    throw new Error(
      `PR has at least ${MAX_PR_COMMITS} commits; GitHub truncates commit analysis, so Intent cannot validate release intent safely`,
    )
  }
  const commitAnalysis = commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    result: analyzeCommit(c.commit.message),
  }))
  const maxCommitBump = commitAnalysis.reduce((max, { result }) => {
    const bump = result.bumpLevel ?? 'none'
    return bumpGt(bump, max) ? bump : max
  }, 'none')
  const hasConflict = titleResult.valid && bumpGt(maxCommitBump, titleResult.bumpLevel)
  log(`commits-analyzed=${commitAnalysis.length} max-commit-bump=${maxCommitBump}`)

  const shouldPostComment =
    commentMode === 'always' || (commentMode === 'failures' && (!titleResult.valid || hasConflict))
  let commentStatus
  if (shouldPostComment) {
    try {
      let releaseContext = null
      try {
        releaseContext = await resolvePullRequestReleaseContext({
          token,
          repo,
          defaultBranch,
          scope: releaseScope,
          prefix: tagPrefix,
          getTags,
          compare,
          getCommitsForBranch,
        })
      } catch (err) {
        log(`release-context=skipped reason=${JSON.stringify(err.message)}`)
      }

      await upsert(
        token,
        repo,
        prNumber,
        MARKER,
        buildComment({ titleResult, title, commitAnalysis, maxCommitBump, releaseContext }),
        [GENERATED_HEADER, GENERATED_FOOTER],
      )
      log('comment=updated')
      commentStatus = 'updated'
    } catch (err) {
      warn(describeCommentFailure(err))
      log('comment=failed')
      commentStatus = 'failed'
    }
  } else {
    const reason = commentMode === 'never' ? 'pr-comment-false' : 'pr-comment-failures-pass'
    log(`comment=skipped reason=${reason}`)
    commentStatus = commentMode === 'never' ? 'disabled' : 'not needed'
  }

  appendStepSummary(buildPullRequestSummary({ title, titleResult, commitAnalysis, maxCommitBump, commentStatus }))
  setOutput('release-needed', String(titleResult.valid && titleResult.bumpLevel !== 'none'))
  setOutput('bump-level', titleResult.valid ? titleResult.bumpLevel : '')

  if (!titleResult.valid) {
    for (const err of titleResult.errors) fail(err)
    fail(titleFix(titleResult))
    log('result=fail reason=invalid-title')
    process.exit(1)
  }

  if (hasConflict) {
    for (const { sha, message, result } of commitAnalysis) {
      if (bumpGt(result.bumpLevel ?? 'none', titleResult.bumpLevel)) {
        fail(
          `commit ${sha.slice(0, 7)} implies ${result.bumpLevel} bump > title ${titleResult.bumpLevel}: ${firstLine(message)}`,
        )
      }
    }
    fail(`commits require ${maxCommitBump} bump but PR title signals ${titleResult.bumpLevel}`)
    log('result=fail reason=bump-conflict')
    process.exit(1)
  }

  log(`result=pass title-bump=${titleResult.bumpLevel} release-needed=${titleResult.bumpLevel !== 'none'}`)
}

function runVersion() {
  const scope = input('RELEASE-SCOPE')
  const prefix = input('TAG-PREFIX', 'v')
  const initialVersion = input('INITIAL-VERSION', '0.0.0')
  const releasePaths = parsePaths(input('RELEASE-PATHS'))
  const releaseIgnorePaths = parsePaths(input('RELEASE-IGNORE-PATHS'))
  const reservedTagsInput = input('RESERVED-TAGS')

  // The tag pattern is interpolated into `git tag --list` before any `--`, so a leading dash would be parsed as a flag.
  // Reject it (inputs are trusted, but this keeps a misconfiguration from silently turning into an option).
  for (const [name, value] of [
    ['tag-prefix', prefix],
    ['release-scope', scope],
  ]) {
    validateTagComponent(name, value)
  }
  validateNoControlCharacters('initial-version', initialVersion)
  releasePaths.forEach((path, index) => validateNoControlCharacters(`release-paths entry ${index + 1}`, path))
  releaseIgnorePaths.forEach((path, index) =>
    validateNoControlCharacters(`release-ignore-paths entry ${index + 1}`, path),
  )
  const reservedTags = parseReservedTags(reservedTagsInput, { scope, prefix })

  log('mode=version')
  log(`inputs release-scope=${scope || '-'} tag-prefix=${prefix || '-'} initial-version=${initialVersion}`)
  if (releasePaths.length > 0) log(`release-paths=${releasePaths.join(' ')}`)
  if (releaseIgnorePaths.length > 0) log(`release-ignore-paths=${releaseIgnorePaths.join(' ')}`)
  if (reservedTags.length > 0) log(`reserved-tags=${reservedTags.length} configured`)

  const tagPattern = scope ? `${scope}/${prefix}*` : `${prefix}*`
  const tagOutput = git(['tag', '--list', tagPattern, '--sort=-v:refname'])
  const previousTag = findLatestTag(tagOutput, scope, prefix)
  log(`tag-pattern=${tagPattern} previous-tag=${previousTag || '-'}`)

  const pathspecs = buildReleasePathspecs(releasePaths, releaseIgnorePaths)
  if (pathspecs.length > 0) log(`git-pathspecs=${pathspecs.join(' ')}`)
  const commitMessages = parseCommitLog(git(buildLogArgs(previousTag, pathspecs)))
  log(`commits-analyzed=${commitMessages.length}`)

  const result = resolveVersion({ initialVersion, tagOutput, commitMessages, scope, prefix, reservedTags })
  const reservedTagWarning = describeReservedTagsSkipped(result)
  if (reservedTagWarning) warn(reservedTagWarning)
  writeVersionOutputs(result)
  appendStepSummary(buildVersionSummary(result))
  log(
    `result=pass release-needed=${result.releaseNeeded} bump=${result.bumpLevel} current=${result.currentVersion} next=${result.nextVersion} release-tag=${result.releaseTag}`,
  )
}

function validateTagComponent(name, value) {
  const text = String(value ?? '')
  if (text.startsWith('-')) throw new Error(`${name} must not start with "-", got ${JSON.stringify(text)}`)
  validateNoControlCharacters(name, text)
}

function validateNoControlCharacters(name, value) {
  const text = String(value ?? '')
  if (hasControlCharacters(text)) {
    throw new Error(`${name} must not contain control characters, got ${JSON.stringify(text)}`)
  }
}

function hasControlCharacters(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

async function main() {
  const eventName = process.env['GITHUB_EVENT_NAME'] ?? ''
  const payload = eventPayload()

  if (isPREvent(eventName)) {
    const releaseScope = input('RELEASE-SCOPE')
    const tagPrefix = input('TAG-PREFIX', 'v')
    validateTagComponent('release-scope', releaseScope)
    validateTagComponent('tag-prefix', tagPrefix)

    await runPullRequest({
      payload,
      token: input('GITHUB-TOKEN'),
      postComment: commentModeInput('PR-COMMENT', 'failures'),
      releaseScope,
      tagPrefix,
    })
    return
  }

  runVersion()
}

if (require.main === module) {
  main().catch((err) => {
    fail(err.message)
    log('result=fail reason=exception')
    process.exit(1)
  })
}

module.exports = {
  describeCommentFailure,
  describeReservedTagsSkipped,
  escapeCommandValue,
  main,
  parseCommentMode,
  runPullRequest,
  setOutput,
  validateTagComponent,
  validateNoControlCharacters,
}
