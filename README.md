# Intent

GitHub Action that validates pull request release intent and resolves the next semantic version from
[Conventional Commit](https://www.conventionalcommits.org/) history.

Most release actions either inspect commits after merge or lint pull request titles before merge. Intent connects both
sides of that workflow:

- **Reviewable release intent before merge.** The PR title declares the intended bump, so reviewers can see and discuss
  the release impact before the branch lands.
- **Commit evidence still matters.** Intent checks the PR commits and fails if any commit implies a stronger bump than
  the title promises, including accidental or hidden breaking-change markers.
- **Squash-merge friendly by design.** The PR title is the pre-merge signal; after merge, the default-branch commit
  history becomes the trusted source for concrete release tags.
- **Release context in the PR.** When relevant, the PR comment shows whether the default branch already requires a bump
  and whether this PR would raise the projected next release.
- **One action for guard and resolution.** The same rules validate PRs and later resolve `next-version`, `release-tag`,
  and floating major/minor tags from Git history.

Use Intent when release decisions should be explicit, reviewable, and consistent instead of inferred only after merge.

## Getting Started

Intent covers two complementary jobs. Use both together for a complete release pipeline.

**PR Guard** -- validates the PR title and checks that no commit requires a higher bump than the title promises. Posts
an explanatory comment on the PR only when something needs attention, and updates that comment to the resolved state
once the check passes again.

When a PR comment is posted, Intent also includes release context from the default branch when relevant: the current
default-branch bump since the latest matching release tag, and whether this PR would raise the projected next release.
For squash-merge repositories, configure GitHub to use the PR title as the squash commit title; otherwise a single
commit PR can lose a stronger PR-title bump during merge. Intent warns when it detects that risk.

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
      - uses: goeselt/intent@<sha>
```

> [!NOTE]
>
> `edited` is needed so that fixing a PR title triggers a fresh validation run -- without it, re-running a failed job
> replays the original event payload and still validates the old title. The downside is that every title or description
> edit also re-triggers any other steps in the same workflow. If you have expensive required checks, keep Intent in a
> small dedicated workflow with `edited` and keep the heavyweight CI workflow on `opened`, `synchronize`, and `reopened`
> only. Then add both checks to your branch protection or ruleset, for example `Intent / Intent` and `CI / CI`.
> Requiring only `CI` does not make a failing Intent check block merges. See the
> [Integration Guide](docs/integration-guide.md#required-checks) for details.

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
      - uses: actions/checkout@<sha>
        with:
          fetch-depth: 0 # full history needed to find the previous release tag

      - id: intent
        uses: goeselt/intent@<sha>

      - name: Dispatch
        if: steps.intent.outputs.release-needed == 'true'
        uses: goeselt/dispatch@<sha>
        with:
          release-tag: ${{ steps.intent.outputs.release-tag }}
          major-tag: ${{ steps.intent.outputs.major-tag }}
          minor-tag: ${{ steps.intent.outputs.minor-tag }}
```

For fork PRs, tag protection, scoped releases, and path filters, see the [Integration Guide](docs/integration-guide.md).

## Inputs

| Input                  | Default    | Mode | Description                                                          |
| ---------------------- | ---------- | ---- | -------------------------------------------------------------------- |
| `github-token`         | token      | PR   | Token used to list PR commits and post the PR comment.               |
| `pr-comment`           | `failures` | PR   | Comment policy: `failures`, `true`/`always`, or `false`/`never`.     |
| `release-scope`        |            | both | Tag namespace for scoped releases, e.g. `cli` --> `cli/v1.2.3`.      |
| `tag-prefix`           | `v`        | both | Prefix for version tags, e.g. `v` for `v1.2.3`.                      |
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
