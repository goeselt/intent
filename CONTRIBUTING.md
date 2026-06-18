# Contributing to Intent

## Design

Pure Node.js standard library -- no runtime dependencies, no build step. The entry point `index.js` is committed as-is
and referenced directly by `action.yml` (`runs.using: node24`).

| File         | Responsibility                                                                            |
| ------------ | ----------------------------------------------------------------------------------------- |
| `index.js`   | Event routing, input parsing, Git command wiring, outputs, and mode orchestration.        |
| `version.js` | Conventional Commit parsing, PR bump validation, tag/pathspec helpers, version resolving. |
| `comment.js` | Markdown PR comment rendering and PR-comment sanitization.                                |
| `summary.js` | GitHub job summary rendering. Pure formatting only; no filesystem writes.                 |
| `github.js`  | GitHub REST calls: list PR commits, resolve posting identity, upsert comment.             |

`pull_request` events run PR validation only; all other events run version resolution only. Push mode requires
`actions/checkout` with `fetch-depth: 0` -- shallow clones may not contain the tags and commit history needed to resolve
the next version.

## Maintainer Map

If you change:

- Conventional Commit rules or bump semantics, update `version.js` and `version.test.js`.
- PR comment wording or Markdown tables, update `comment.js` and `comment.test.js`.
- Job summary wording, update `summary.js` and `summary.test.js`.
- GitHub API behavior or sticky-comment matching, update `github.js` and `github.test.js`.
- Inputs, outputs, event-mode wiring, logs, or exit behavior, update `index.js`, `index.test.js`, `action.yml`, and
  usually `README.md`.

Keep `index.js` boring. It should read as: load inputs, route event, call domain helpers, write outputs/summary, set the
exit code. Prefer moving formatting into `comment.js` or `summary.js` and pure release logic into `version.js`.

## Invariants

- No runtime dependencies and no build step. This action should be easy to inspect from the checked-in source.
- Do not run user-controlled data through a shell. Git calls use `execFileSync('git', args)`.
- Escape GitHub workflow-command values before writing `::warning` or `::error` annotations.
- Write multiline outputs with GitHub's multiline output syntax, not raw `name=value` lines.
- Keep GitHub API calls bounded with explicit request timeouts and response-size limits.
- Keep PR titles and commit subjects sanitized in comments and summaries. Avoid bare `@mentions` and broken Markdown
  tables.
- Keep PR commit analysis fail-closed when GitHub may truncate the commit list at 250 commits.
- Keep reserved-tag handling explicit. Deleted immutable-release tags are not discoverable from checkout; users must
  list known unusable tag names in `reserved-tags`, and the action must not log the full configured list.
- Do not identify the sticky PR comment by the hidden marker alone when the posting identity is unknown. The fallback
  must require both a Bot author and the visible generated-comment header/footer.
- Treat matching Git tags as trusted release state. The action may reject malformed SemVer tags, but repository rules
  must protect the tag namespace from unauthorized creation or rewrites.

## Development Setup

- Node.js 20 or later

No dependencies to install.

## Local Verification

Fast path:

```bash
npm test
```

Lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). Intent reads its
own commit history to resolve the next version, so the format is load-bearing.
