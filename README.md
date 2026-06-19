# Intent

GitHub Action that validates pull request release intent and resolves the next semantic version from
[Conventional Commit](https://www.conventionalcommits.org/) history.

Designed for squash-merge workflows: the PR title is the release signal, and the default-branch commit history drives
the concrete version.

Use Intent when release decisions should be explicit, reviewable, and consistent: it rejects ambiguous PR titles, checks
whether commits imply a stronger bump than the title promises, and turns trusted Git history into concrete release tags.

## Getting Started

Intent covers two complementary jobs. Use both together for a complete release pipeline.

**PR Guard** -- validates the PR title and checks that no commit requires a higher bump than the title promises. Posts
an explanatory comment on the PR only when something needs attention.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read # read commit history
  pull-requests: write # post PR comment

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: goeselt/intent@v1
```

> [!NOTE]
>
> `edited` is needed so that fixing a PR title triggers a fresh validation run -- without it, re-running a failed job
> replays the original event payload and still validates the old title. The downside is that every title or description
> edit also re-triggers any other steps in the same workflow. Guard expensive jobs with
> `if: github.event.action != 'edited'`, or keep Intent in a separate small job. See the
> [Integration Guide](docs/integration-guide.md#activity-types) for details.

**Version Resolution** -- on every push to main, reads Git tags and commit history to decide whether a release is needed
and what the next version should be. The resolved release plan is written to the job summary and to action outputs.

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

For fork PRs, tag protection, scoped releases, and path filters, see the [Integration Guide](docs/integration-guide.md).

## Inputs

| Input                  | Default    | Mode | Description                                                          |
| ---------------------- | ---------- | ---- | -------------------------------------------------------------------- |
| `github-token`         | token      | PR   | Token used to list PR commits and post the PR comment.               |
| `pr-comment`           | `failures` | PR   | Comment policy: `failures`, `true`/`always`, or `false`/`never`.     |
| `release-scope`        |            | push | Tag namespace for scoped releases, e.g. `cli` --> `cli/v1.2.3`.      |
| `tag-prefix`           | `v`        | push | Prefix for version tags, e.g. `v` for `v1.2.3`.                      |
| `initial-version`      | `0.0.0`    | push | Version used when no matching release tag exists yet.                |
| `release-paths`        |            | push | Newline-separated paths allowed to contribute to version resolution. |
| `release-ignore-paths` |            | push | Newline-separated paths excluded from version resolution.            |
| `reserved-tags`        |            | push | Full tag names that must not be proposed.                            |

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
| `major-version`   | `1`      | Floating major version without prefix/scope. Push only. |
| `minor-version`   | `1.3`    | Floating minor version without prefix/scope. Push only. |

## Commit Mapping

| Pattern                   | Bump    |
| ------------------------- | ------- |
| `!` after type or scope   | `major` |
| `BREAKING CHANGE:` footer | `major` |
| `feat: ...`               | `minor` |
| `fix: ...` / `perf: ...`  | `patch` |
| Other accepted types      | `none`  |

Accepted types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
