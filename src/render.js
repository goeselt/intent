'use strict'

// Shared Markdown rendering helpers for the PR comment and the job summary.
//
// User-controlled strings (PR title, commit subjects) are always rendered inside an inline-code span.
// That neutralizes @mentions and #refs (no stray notifications) and most Markdown.
// Two characters still need handling:
//   - backtick: would close the code span early
//   - pipe:     breaks table-cell layout (escaped per GFM, only inside cells)

const { hasBreakingBang, hasBreakingFooter } = require('./version.js')

/** Collapses whitespace and removes backticks; never wraps. */
function clean(str) {
  return String(str ?? '')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
}

/** Inline-code span for prose. */
function code(str) {
  return `\`${clean(str)}\``
}

function escapeTablePipes(str) {
  return String(str).split('|').join('\\|')
}

/** Inline-code span for a table cell: also escapes pipes (GFM unescapes them). */
function cell(str, maxLen) {
  let text = clean(str)
  if (maxLen && text.length > maxLen) {
    text = `${text.slice(0, maxLen - 1)}...`
  }
  return `\`${escapeTablePipes(text)}\``
}

function shortSha(sha) {
  return String(sha ?? '').slice(0, 7)
}

/** One-line explanation of why a commit message produces the given bump level. */
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

module.exports = { bumpReason, cell, clean, code, escapeTablePipes, shortSha }
