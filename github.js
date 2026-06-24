'use strict'

const https = require('node:https')

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_RELEASE_CONTEXT_COMMITS = 250
const MAX_RELEASE_CONTEXT_TAGS = 1000

function githubApiBase() {
  const base = new URL(process.env.GITHUB_API_URL || 'https://api.github.com')
  if (base.protocol !== 'https:') throw new Error(`GITHUB_API_URL must use https, got ${base.protocol}`)
  return base
}

function requestOptions(method, path, token, payload) {
  const base = githubApiBase()
  const basePath = base.pathname.replace(/\/+$/, '')
  return {
    hostname: base.hostname,
    port: base.port || undefined,
    path: `${basePath}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'intent',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
  }
}

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const options = requestOptions(method, path, token, payload)

    const req = https.request(options, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (c) => {
        bytes += c.length
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`GitHub API ${method} ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) {
          settle(reject, new Error(`GitHub API ${method} ${path} --> HTTP ${res.statusCode}: ${raw}`))
          return
        }
        try {
          settle(resolve, raw ? JSON.parse(raw) : null)
        } catch (err) {
          settle(reject, new Error(`GitHub API ${method} ${path} returned invalid JSON: ${err.message}`))
        }
      })
    })

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`GitHub API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.on('error', (err) => settle(reject, err))
    if (payload) req.write(payload)
    req.end()
  })
}

// GitHub caps "list PR commits" at 250 results regardless of pagination:
// https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
const MAX_PR_COMMITS = 250

// Matches the action's own sticky comment. The marker is the primary identity. When the author login is known it is
// also required, so a stray comment from someone else that happens to carry the marker is not edited. When the login
// could not be resolved (see authenticatedLogin), only match Bot-authored comments that also carry the visible
// generated-comment sentinels. That preserves sticky comments for GITHUB_TOKEN/App tokens without letting a human PR
// author claim the marker and get their comment overwritten.
function commentMatches(comment, marker, authorLogin, generatedSentinels = []) {
  if (typeof comment?.body !== 'string' || !comment.body.includes(marker)) return false
  if (!authorLogin) {
    return (
      comment?.user?.type === 'Bot' &&
      generatedSentinels.length > 0 &&
      generatedSentinels.every((sentinel) => comment.body.includes(sentinel))
    )
  }
  return typeof comment?.user?.login === 'string' && comment.user.login === authorLogin
}

// Resolves the login the action posts under, so upsert only edits its own comment.
// The default GITHUB_TOKEN is a GitHub App installation token, and GitHub rejects GET /user for it with
// "HTTP 403 Resource not accessible by integration". A custom App token behaves the same way. Treat any 4xx
// as "identity unavailable"; let network/5xx errors propagate so a real outage surfaces immediately rather than
// silently posting a duplicate comment.
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

async function getRepositoryTags(token, repo, maxTags = MAX_RELEASE_CONTEXT_TAGS) {
  const tags = []
  for (let page = 1; ; page++) {
    const batch = await request('GET', `/repos/${repo}/tags?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    tags.push(...batch)
    if (tags.length > maxTags) {
      throw new Error(`repository has more than ${maxTags} tags; release context analysis is capped`)
    }
    if (batch.length < 100) break
  }
  return tags
}

async function compareCommits(token, repo, base, head, maxCommits = MAX_RELEASE_CONTEXT_COMMITS) {
  const commits = []
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`

  for (let page = 1; ; page++) {
    const result = await request('GET', `/repos/${repo}/compare/${range}?per_page=100&page=${page}`, token)
    if (page === 1 && Number.isSafeInteger(result?.total_commits) && result.total_commits > maxCommits) {
      throw new Error(
        `comparison has ${result.total_commits} commits; release context analysis is capped at ${maxCommits}`,
      )
    }

    const batch = Array.isArray(result?.commits) ? result.commits : []
    if (batch.length === 0) break
    commits.push(...batch)
    if (commits.length > maxCommits) {
      throw new Error(`comparison has more than ${maxCommits} commits; release context analysis is capped`)
    }
    if (batch.length < 100) break
  }

  return commits
}

async function getBranchCommits(token, repo, branch, maxCommits = MAX_RELEASE_CONTEXT_COMMITS) {
  const commits = []
  const encodedBranch = encodeURIComponent(branch)

  for (let page = 1; commits.length <= maxCommits; page++) {
    const batch = await request('GET', `/repos/${repo}/commits?sha=${encodedBranch}&per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    commits.push(...batch)
    if (batch.length < 100) break
  }

  if (commits.length > maxCommits) {
    throw new Error(`default branch has more than ${maxCommits} commits; release context analysis is capped`)
  }

  return commits
}

async function upsertComment(token, repo, prNumber, marker, body, generatedSentinels = []) {
  const authorLogin = await authenticatedLogin(token)

  // Find existing bot comment
  let existing = null
  let page = 1
  for (;;) {
    const batch = await request('GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    existing = batch.find((c) => commentMatches(c, marker, authorLogin, generatedSentinels)) ?? null
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

module.exports = {
  authenticatedLogin,
  commentMatches,
  compareCommits,
  getBranchCommits,
  getPRCommits,
  getRepositoryTags,
  request,
  requestOptions,
  upsertComment,
  MAX_PR_COMMITS,
  MAX_RELEASE_CONTEXT_COMMITS,
  MAX_RELEASE_CONTEXT_TAGS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
}
