'use strict'

const { bumpGt, firstLine } = require('./version.js')
const { bumpReason, cell, code, shortSha } = require('./render.js')

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
      `If the flagged commit message is correct, update the PR title to declare ${code(maxCommitBump)}. If it overstates the change, rewrite it so it no longer implies a higher bump.`,
      'With merge or rebase merges, commits land on the default branch as written; with squash merges that use the PR title as the squash commit title, only `BREAKING CHANGE:` footers keep their release effect.',
    )
  }

  if (commitAnalysis.length > 0) {
    lines.push('', '| SHA | Subject | Bump | Reason |', '| :-- | :------ | :--: | :----- |')
    for (const { sha, message, result: commitResult } of commitAnalysis.slice(0, 25)) {
      const bump = commitResult.bumpLevel ?? 'none'
      const marker = titleResult.valid && bumpGt(bump, titleResult.bumpLevel) ? ' (conflict)' : ''
      lines.push(
        `| ${code(shortSha(sha))} | ${cell(firstLine(message), 72)} | ${code(`${bump}${marker}`)} | ${bumpReason(
          message,
          bump,
        )} |`,
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
