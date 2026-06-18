'use strict'

const TYPES = new Set(['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'])
const TYPE_ALIASES = { feature: 'feat', bug: 'fix', performance: 'perf', doc: 'docs' }

const BUMP_ORDER = { none: 0, patch: 1, minor: 2, major: 3 }
const HEADER_RE = /^([a-z]+)(\([^)]+\))?(!)?: (.*)$/
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function bumpGt(a, b) {
  return (BUMP_ORDER[a] ?? -1) > (BUMP_ORDER[b] ?? -1)
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/)[0]
}

function canonicalType(type) {
  return TYPE_ALIASES[type] ?? type
}

function deriveBump(type, breaking) {
  if (breaking) return 'major'
  if (type === 'feat') return 'minor'
  if (type === 'fix' || type === 'perf') return 'patch'
  return 'none'
}

function validate(rawTitle) {
  const title = firstLine(rawTitle)

  if (title.trim() === '') {
    return { valid: false, bumpLevel: null, errors: ['PR title is empty'] }
  }

  const match = title.match(HEADER_RE)
  if (!match) {
    return {
      valid: false,
      bumpLevel: null,
      errors: [
        'title does not match <type>[scope][!]: <description>',
        `got: ${title}`,
        `allowed types: ${[...TYPES].sort().join(', ')}`,
      ],
    }
  }

  const [, rawType, , bang, description] = match
  const type = canonicalType(rawType)

  if (type !== rawType && TYPES.has(type)) {
    return {
      valid: false,
      bumpLevel: null,
      errors: [`type "${rawType}" is not canonical; use "${type}"`],
      suggestion: type + title.slice(rawType.length),
    }
  }

  if (!TYPES.has(type)) {
    return {
      valid: false,
      bumpLevel: null,
      errors: [`unknown type "${rawType}"`, `allowed types: ${[...TYPES].sort().join(', ')}`],
    }
  }

  if (description.trim() === '') {
    return { valid: false, bumpLevel: null, errors: ['empty description after ": "'] }
  }

  const bumpLevel = deriveBump(type, bang === '!')
  return { valid: true, bumpLevel, errors: [] }
}

function analyzeCommit(message) {
  const text = String(message ?? '')
  if (text.trim() === '') {
    return { valid: false, bumpLevel: 'none', errors: ['commit message is empty'] }
  }

  const result = validate(text)
  const hasBreakingFooter = text.split(/\r?\n/).some((line) => BREAKING_FOOTER_RE.test(line.trim()))

  if (hasBreakingFooter) {
    return { ...result, bumpLevel: 'major' }
  }

  if (!result.valid) {
    return { valid: false, bumpLevel: 'none', errors: result.errors }
  }

  return result
}

function maxBump(messages) {
  return messages.reduce((max, message) => {
    const bump = analyzeCommit(message).bumpLevel
    return bumpGt(bump, max) ? bump : max
  }, 'none')
}

function parseSemver(version) {
  const match = String(version ?? '').match(SEMVER_RE)
  if (!match) {
    throw new Error(`invalid semantic version ${JSON.stringify(version)}: expected major.minor.patch`)
  }
  return match.slice(1).map((part) => {
    const value = Number.parseInt(part, 10)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`invalid semantic version ${JSON.stringify(version)}: version number is too large`)
    }
    return value
  })
}

function isValidSemver(version) {
  try {
    parseSemver(version)
    return true
  } catch {
    return false
  }
}

function applyBump(version, bump) {
  const [major, minor, patch] = parseSemver(version)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  return version
}

function tagBase(scope, prefix) {
  return scope ? `${scope}/${prefix}` : prefix
}

function extractVersion(tag, scope, prefix) {
  return tag.slice(tagBase(scope, prefix).length)
}

function findLatestTag(tagOutput, scope, prefix) {
  const base = tagBase(scope, prefix)
  for (const line of String(tagOutput ?? '').split(/\r?\n/)) {
    const tag = line.trim()
    if (!tag.startsWith(base)) continue

    const version = tag.slice(base.length)
    if (isValidSemver(version)) return tag
  }
  return ''
}

function formatTags(version, scope, prefix) {
  const [major, minor] = parseSemver(version)
  const base = tagBase(scope, prefix)
  return {
    releaseTag: `${base}${version}`,
    majorTag: `${base}${major}`,
    minorTag: `${base}${major}.${minor}`,
  }
}

function parseCommitLog(output) {
  return String(output ?? '')
    .split('\x00')
    .map((message) => message.trim())
    .filter(Boolean)
}

function parsePaths(input) {
  return String(input ?? '')
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
}

function buildReleasePathspecs(releasePaths, releaseIgnorePaths) {
  const includes = [...releasePaths]
  const excludes = releaseIgnorePaths.map((path) => `:(exclude)${path}`)

  if (includes.length === 0 && excludes.length > 0) {
    includes.push('.')
  }

  return [...includes, ...excludes]
}

// Builds `git log` arguments. Without a previous tag, the range is HEAD (commits
// reachable from the current branch) -- never --all, which would pull in commits
// from unrelated refs and could inflate the bump.
function buildLogArgs(previousTag, pathspecs = []) {
  const args = ['log', '--format=%x00%B', previousTag ? `${previousTag}..HEAD` : 'HEAD']
  if (pathspecs.length > 0) {
    args.push('--', ...pathspecs)
  }
  return args
}

function resolveVersion({ initialVersion, tagOutput, commitMessages, scope = '', prefix = 'v' }) {
  parseSemver(initialVersion)

  const previousTag = findLatestTag(tagOutput, scope, prefix)
  const currentVersion = previousTag ? extractVersion(previousTag, scope, prefix) : initialVersion
  parseSemver(currentVersion)

  const bump = maxBump(commitMessages)
  const nextVersion = applyBump(currentVersion, bump)
  const tags = formatTags(nextVersion, scope, prefix)

  return {
    releaseNeeded: bump !== 'none',
    bumpLevel: bump,
    currentVersion,
    nextVersion,
    previousTag,
    ...tags,
  }
}

module.exports = {
  TYPES,
  analyzeCommit,
  applyBump,
  bumpGt,
  extractVersion,
  firstLine,
  findLatestTag,
  formatTags,
  maxBump,
  parseCommitLog,
  parsePaths,
  buildReleasePathspecs,
  buildLogArgs,
  parseSemver,
  resolveVersion,
  validate,
}
