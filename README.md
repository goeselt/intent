# Intent

GitHub Action that validates pull request release intent and resolves the next semantic version from
[Conventional Commit](https://www.conventionalcommits.org/) history. Use it as
[`goeselt/intent`](https://github.com/goeselt/intent).

Designed for squash-merge workflows: the PR title is the release signal, and the default-branch commit history drives
the concrete version.

## Quick Start

Intent covers two complementary jobs. Use both together for a complete release pipeline.

**1. PR Guard** -- validates the PR title and checks that no commit requires a higher bump than the title promises.
Posts an explanatory comment on the PR only when something needs attention.

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: goeselt/intent@v1
```

Title and commit validation always run and set the job's exit code. If the token lacks `pull-requests: write` (or the
comment otherwise can't be posted), Intent does not fail the job for that alone -- it emits a `::warning` annotation and
continues, so validation results stay visible in annotations and the job summary even without the PR comment.

By default, `pr-comment: failures` keeps quiet on passing PRs and comments only when the PR author needs to act. Use
`pr-comment: true` (or `always`) if you want a sticky comment on every run, and `pr-comment: false` (or `never`) to
disable PR comments entirely. `github-token` defaults to `${{ github.token }}`; pass a custom token only when your
workflow needs one.

For PRs from forks, GitHub always issues a read-only `GITHUB_TOKEN` on `pull_request`, regardless of the `permissions:`
block above -- so the comment step degrades to the warning just described for every fork PR. To post comments on fork
PRs, trigger on `pull_request_target` instead, which runs with the base repository's permissions. Review GitHub's
[security guidance for `pull_request_target`](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
first: the workflow then runs with write access against untrusted PR code, so never check out or execute the fork's
contents in that job.

**2. Version Resolution** -- on every push to main, reads Git tags and commit history to decide whether a release is
needed and what the next version should be. The resolved release plan is written to the job summary and to action
outputs.

```yaml
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - id: intent
        uses: goeselt/intent@v1

      - name: Dispatch
        if: steps.intent.outputs.release-needed == 'true'
        uses: goeselt/dispatch@v1
        with:
          release-tag: ${{ steps.intent.outputs.release-tag }}
          major-tag: ${{ steps.intent.outputs.major-tag }}
          minor-tag: ${{ steps.intent.outputs.minor-tag }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input                  | Default | Mode | Description                                                          |
| ---------------------- | ------- | ---- | -------------------------------------------------------------------- |
| `github-token`         | token      | PR   | Token used to list PR commits and post the PR comment.               |
| `pr-comment`           | `failures` | PR   | Comment policy: `failures`, `true`/`always`, or `false`/`never`.     |
| `release-scope`        |         | push | Tag namespace for scoped releases, e.g. `cli` --> `cli/v1.2.3`.      |
| `tag-prefix`           | `v`     | push | Prefix for version tags, e.g. `v` for `v1.2.3`.                      |
| `initial-version`      | `0.0.0` | push | Version used when no matching release tag exists yet.                |
| `release-paths`        |         | push | Newline-separated paths allowed to contribute to version resolution. |
| `release-ignore-paths` |         | push | Newline-separated paths excluded from version resolution.            |

`release-paths` and `release-ignore-paths` accept Git pathspecs, one per line. When `release-paths` is set, only commits
touching those paths can contribute a bump. When `release-ignore-paths` is set, commits touching only ignored paths are
excluded.

## Outputs

| Output            | Example  | Description                                             |
| ----------------- | -------- | ------------------------------------------------------- |
| `release-needed`  | `true`   | Whether the PR title or commit history needs a release. |
| `bump-level`      | `minor`  | Bump level: `major`, `minor`, `patch`, or `none`.       |
| `current-version` | `1.2.3`  | Current version without tag prefix. Push only.          |
| `next-version`    | `1.3.0`  | Next version without tag prefix. Push only.             |
| `previous-tag`    | `v1.2.3` | Latest matching release tag. Push only.                 |
| `release-tag`     | `v1.3.0` | Full release tag. Push only.                            |
| `major-tag`       | `v1`     | Floating major tag. Push only.                          |
| `minor-tag`       | `v1.3`   | Floating minor tag. Push only.                          |

## Commit Mapping

| Pattern                   | Bump    |
| ------------------------- | ------- |
| `!` after type or scope   | `major` |
| `BREAKING CHANGE:` footer | `major` |
| `feat: ...`               | `minor` |
| `fix: ...` / `perf: ...`  | `patch` |
| Other accepted types      | `none`  |

Accepted types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## Usage Examples

**Scoped release** (monorepo with multiple independently versioned tools):

```yaml
- id: intent
  uses: goeselt/intent@v1
  with:
    release-scope: cli
    release-paths: |
      cmd/cli
      internal/cli
      .goreleaser.yaml
    release-ignore-paths: |
      docs/
      README.md
```

Tags become `cli/v1.2.3`; floating tags become `cli/v1` and `cli/v1.2`.

**Always comment on PRs** (create or update the sticky comment even when the PR already passes):

```yaml
- uses: goeselt/intent@v1
  with:
    pr-comment: true
```

**Silent PR check** (no comment posted, check status and summary only):

```yaml
- uses: goeselt/intent@v1
  with:
    pr-comment: false
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
