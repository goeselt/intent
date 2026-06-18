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

function cell(value, maxLen) {
  let rendered = text(value)
  if (maxLen && rendered.length > maxLen) rendered = `${rendered.slice(0, maxLen - 1)}...`
  return code(rendered.replace(/\|/g, '\\|'))
}

function titleFix() {
  return 'Use `<type>[scope][!]: <description>`, for example `feat: add login` or `fix(auth)!: remove deprecated endpoint`.'
}

function fieldTable(rows) {
  return ['| Field | Value |', '| :-- | :-- |', ...rows.map(([field, value]) => `| ${field} | ${value} |`)]
}

function buildPullRequestSummary({ title, titleResult, commitAnalysis, maxCommitBump, commentStatus }) {
  const titleBump = titleResult.valid ? titleResult.bumpLevel : 'invalid'
  const hasConflict = titleResult.valid && bumpGt(maxCommitBump, titleResult.bumpLevel)
  const result = !titleResult.valid ? 'fail - invalid title' : hasConflict ? 'fail - bump conflict' : 'pass'
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
      `Update the PR title to signal a ${code(maxCommitBump)} bump, or amend the flagged commit(s) so they no longer require more than ${code(titleResult.bumpLevel)}.`,
    )
  }

  if (commitAnalysis.length > 0) {
    lines.push('', '| SHA | Subject | Bump |', '| :-- | :------ | :--: |')
    for (const { sha, message, result: commitResult } of commitAnalysis.slice(0, 25)) {
      const bump = commitResult.bumpLevel ?? 'none'
      const marker = titleResult.valid && bumpGt(bump, titleResult.bumpLevel) ? ' (conflict)' : ''
      lines.push(
        `| ${code(String(sha ?? '').slice(0, 7))} | ${cell(firstLine(message), 72)} | ${code(`${bump}${marker}`)} |`,
      )
    }
    if (commitAnalysis.length > 25) {
      lines.push(`| ... | ${code(`${commitAnalysis.length - 25} more commits`)} | ... |`)
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
