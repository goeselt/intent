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

function buildPullRequestSummary({ title, titleResult, commitAnalysis, maxCommitBump, commentStatus }) {
  const titleBump = titleResult.valid ? titleResult.bumpLevel : 'invalid'
  const hasConflict = titleResult.valid && bumpGt(maxCommitBump, titleResult.bumpLevel)
  const result = !titleResult.valid ? 'fail - invalid title' : hasConflict ? 'fail - bump conflict' : 'pass'
  const lines = [
    '## Intent Release Check',
    '',
    `**Result:** ${result}`,
    `**PR title:** ${code(title || '(empty)')}`,
    `**Title bump:** ${code(titleBump)}`,
    `**Highest commit bump:** ${code(maxCommitBump)}`,
  ]

  if (commentStatus) lines.push(`**PR comment:** ${commentStatus}`)

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
  const lines = [
    '## Intent Release',
    '',
    `**Release needed:** ${code(String(result.releaseNeeded))}`,
    `**Bump:** ${code(result.bumpLevel)}`,
    `**Current version:** ${code(result.currentVersion)}`,
    `**Next version:** ${code(result.nextVersion)}`,
    `**Previous tag:** ${code(result.previousTag || '(none)')}`,
    `**Release tag:** ${code(result.releaseTag)}`,
    `**Floating tags:** ${code(result.majorTag)}, ${code(result.minorTag)}`,
    `**Floating versions:** ${code(result.majorVersion)}, ${code(result.minorVersion)}`,
  ]

  if (result.reservedTagsSkipped?.length > 0) {
    lines.push(
      `**Skipped reserved tags:** ${code(String(result.reservedTagsSkipped.length))}`,
      `**Reserved tag alternative:** ${code(result.releaseTag)}`,
    )
  }

  return lines.join('\n')
}

module.exports = { buildPullRequestSummary, buildVersionSummary, titleFix }
