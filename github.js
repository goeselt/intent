'use strict'

const https = require('node:https')

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'intent',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${method} ${path} --> HTTP ${res.statusCode}: ${raw}`))
          return
        }
        resolve(raw ? JSON.parse(raw) : null)
      })
    })

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// GitHub caps "list PR commits" at 250 results regardless of pagination:
// https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
const MAX_PR_COMMITS = 250

// Matches the action's own sticky comment. The marker is the primary identity. When the author login is known
// it is also required, so a stray comment from someone else that happens to carry the marker is not edited.
// When the login could not be resolved (see authenticatedLogin), match on the marker alone.
function commentMatches(comment, marker, authorLogin) {
  if (typeof comment?.body !== 'string' || !comment.body.includes(marker)) return false
  if (!authorLogin) return true
  return typeof comment?.user?.login === 'string' && comment.user.login === authorLogin
}

// Resolves the login the action posts under, so upsert only edits its own comment.
// The default GITHUB_TOKEN is a GitHub App installation token, and GitHub rejects GET /user for it with
// "HTTP 403 Resource not accessible by integration". A custom App token behaves the same way. Treat any 4xx
// as "identity unavailable" and fall back to marker-only matching; let network/5xx errors propagate so a real
// outage surfaces immediately rather than silently posting a duplicate comment.
async function authenticatedLogin(token) {
  try {
    const viewer = await request('GET', '/user', token)
    return typeof viewer?.login === 'string' ? viewer.login : ''
  } catch (err) {
    if (/HTTP 4\d\d/.test(err.message)) return ''
    throw err
  }
}

async function getPRCommits(token, repo, prNumber) {
  const commits = []
  for (let page = 1; ; page++) {
    const batch = await request('GET', `/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    commits.push(...batch)
    if (batch.length < 100) break
  }
  return commits
}

async function upsertComment(token, repo, prNumber, marker, body) {
  const authorLogin = await authenticatedLogin(token)

  // Find existing bot comment
  let existing = null
  let page = 1
  for (;;) {
    const batch = await request('GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    existing = batch.find((c) => commentMatches(c, marker, authorLogin)) ?? null
    if (existing || batch.length < 100) break
    page++
  }

  if (existing) {
    // Skip the write when nothing changed. Avoids a redundant comment edit,
    // which is the only thing that could feed a comment-triggered workflow loop.
    if (normalize(existing.body) === normalize(body)) {
      return existing
    }
    return request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, token, { body })
  }
  return request('POST', `/repos/${repo}/issues/${prNumber}/comments`, token, { body })
}

/** Normalizes line endings so a CRLF round-trip does not count as a change. */
function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

module.exports = { authenticatedLogin, commentMatches, getPRCommits, upsertComment, MAX_PR_COMMITS }
