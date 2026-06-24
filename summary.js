'use strict'

const { bumpGt, firstLine } = require('./version.js')

function text(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
}

function code(value) {
  return `\`${text(value)}\``
}

function escapeTablePipes(value) {
  return String(value).split('|').join('\\|')
}

function cell(value, maxLen) {
  let rendered = text(value)
  if (maxLen && rendered.length > maxLen) rendered = `${rendered.slice(0, maxLen - 1)}...`
  return code(escapeTablePipes(rendered))
}

function hasBreakingFooter(message) {
  return String(message ?? '')
    .split(/\r?\n/)
    .some((line) => /^BREAKING[ -]CHANGE:/.test(line.trim()))
}

function hasBreakingBang(message) {
  return /^([a-z]+)(\([^)]+\))?!: /.test(firstLine(message))
}

function bumpReason(message, bumpLevel) {
  if (bumpLevel === 'major') {
    const bang = hasBreakingBang(message)
    const footer = hasBreakingFooter(message)
    if (bang && footer) return 'contains `!` and a `BREAKING CHANGE` footer'
    if (bang) return 'contains `!`'
    if (footer) return 'contains a `BREAKING CHANGE` footer'
    return 'marks a breaking change'
  }
  if (bumpLevel === 'minor') return '`feat:` means new functionality'
  if (bumpLevel === 'patch') return '`fix:` or `perf:` means a patch change'
  return '--'
}

function titleFix() {
  return 'Edit the PR title in GitHub to use `<type>[scope][!]: <description>`, for example `feat: add login` or `fix(auth)!: remove deprecated endpoint`.'
}

function fieldTable(rows) {
  return ['| Field | Value |', '| :-- | :-- |', ...rows.map(([field, value]) => `| ${field} | ${value} |`)]
}

function buildPullRequestSummary({ title, titleResult, commitAnalysis, maxCommitBump, commentStatus }) {
  const titleBump = titleResult.valid ? titleResult.bumpLevel : 'invalid'
  const hasConflict = titleResult.valid && bumpGt(maxCommitBump, titleResult.bumpLevel)
  const result = titleResult.valid ? (hasConflict ? 'fail - bump conflict' : 'pass') : 'fail - invalid title'
  const rows = [
    ['Result', cell(result)],
    ['PR title', cell(title || '(empty)', 120)],
    ['Title bump', cell(titleBump)],
    ['Highest commit bump', cell(maxCommitBump)],
  ]

  if (commentStatus) rows.push(['PR comment', cell(commentStatus)])

  const lines = ['## Intent Release Check', '', ...fieldTable(rows)]

  if (!titleResult.valid) {
    lines.push('', '**How to fix:**', titleFix(titleResult))
  } else if (hasConflict) {
    lines.push(
      '',
      '**How to fix:**',
      `Intent found a release intent mismatch: the PR title declares ${code(titleResult.bumpLevel)}, but one or more commits imply ${code(maxCommitBump)}.`,
      `If the commit message is correct, update the PR title to declare ${code(maxCommitBump)}. If a flagged commit message overstates the change, rewrite that commit message so it no longer implies a higher bump.`,
      'For squash merges, also make sure the final squash commit message matches the intended bump.',
    )
  }

  if (commitAnalysis.length > 0) {
    lines.push('', '| SHA | Subject | Bump | Reason |', '| :-- | :------ | :--: | :----- |')
    for (const { sha, message, result: commitResult } of commitAnalysis.slice(0, 25)) {
      const bump = commitResult.bumpLevel ?? 'none'
      const marker = titleResult.valid && bumpGt(bump, titleResult.bumpLevel) ? ' (conflict)' : ''
      lines.push(
        `| ${code(String(sha ?? '').slice(0, 7))} | ${cell(firstLine(message), 72)} | ${code(
          `${bump}${marker}`,
        )} | ${bumpReason(message, bump)} |`,
      )
    }
    if (commitAnalysis.length > 25) {
      lines.push(`| ... | ${code(`${commitAnalysis.length - 25} more commits`)} | ... | ... |`)
    }
  }

  return lines.join('\n')
}

function buildVersionSummary(result) {
  const rows = [
    ['Release needed', cell(String(result.releaseNeeded))],
    ['Bump', cell(result.bumpLevel)],
    ['Current version', cell(result.currentVersion)],
    ['Next version', cell(result.nextVersion)],
    ['Previous tag', cell(result.previousTag || '(none)')],
    ['Release tag', cell(result.releaseTag)],
    ['Floating tags', `${cell(result.majorTag)}, ${cell(result.minorTag)}`],
    ['Floating versions', `${cell(result.majorVersion)}, ${cell(result.minorVersion)}`],
  ]

  if (result.reservedTagsSkipped?.length > 0) {
    rows.push(['Skipped reserved tags', cell(String(result.reservedTagsSkipped.length))])
    rows.push(['Reserved tag alternative', cell(result.releaseTag)])
  }

  const lines = ['## Intent Release', '', ...fieldTable(rows)]

  return lines.join('\n')
}

module.exports = { buildPullRequestSummary, buildVersionSummary, titleFix }
