# Contributing to Intent

## Design

Pure Node.js standard library -- no runtime dependencies, no build step. The entry point `index.js` is committed as-is
and referenced directly by `action.yml` (`runs.using: node24`).

| File         | Responsibility                                                      |
| ------------ | ------------------------------------------------------------------- |
| `version.js` | Conventional Commit parsing, PR bump validation, version resolving. |
| `comment.js` | Markdown PR comment rendering and sanitization.                     |
| `github.js`  | GitHub REST calls: list PR commits, upsert comment.                 |
| `index.js`   | Event routing, input reading, Git command wiring, output writing.   |

`pull_request` events run PR validation only; all other events run version resolution only. Push mode requires
`actions/checkout` with `fetch-depth: 0` -- shallow clones may not contain the tags and commit history needed to resolve
the next version.

## Development Setup

- Node.js 20 or later

No dependencies to install.

## Local Verification

Lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Tests:

```bash
npm test
```

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). Intent reads its
own commit history to resolve the next version, so the format is load-bearing.
