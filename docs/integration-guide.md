# Intent -- Integration Guide

- [PR Guard](#pr-guard)
  - [Activity Types](#activity-types)
  - [Required Checks](#required-checks)
  - [Comment Behavior](#comment-behavior)
  - [Squash Merge Commit Titles](#squash-merge-commit-titles)
  - [Token and Annotation Fallback](#token-and-annotation-fallback)
  - [Fork PRs](#fork-prs)
- [Version Resolution](#version-resolution)
  - [Fetch Depth](#fetch-depth)
  - [Tag Namespace Protection](#tag-namespace-protection)
  - [Reserved Tags](#reserved-tags)
  - [Path Filters](#path-filters)
- [Patterns](#patterns)
  - [Scoped Release (Monorepo)](#scoped-release-monorepo)
  - [Floating Docker Image Tags](#floating-docker-image-tags)
  - [Reserved Tag Configuration](#reserved-tag-configuration)
  - [PR Comment Modes](#pr-comment-modes)

---

## PR Guard

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: write

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: goeselt/intent@v1
```

### Activity Types

Each type covers a distinct part of the PR lifecycle:

| Type          | When it fires                       | Why Intent needs it                                 |
| ------------- | ----------------------------------- | --------------------------------------------------- |
| `opened`      | PR is created                       | Validates the initial title.                        |
| `synchronize` | Commits are pushed to the PR branch | Validates commits against the current title.        |
| `reopened`    | Closed PR is brought back to review | Re-validates after the PR was dormant.              |
| `edited`      | PR title or description is changed  | Creates a fresh run with the updated title payload. |

`edited` is the most important one to get right: GitHub re-runs use the original event payload, so re-running a failed
job after fixing the title will still validate the old title. Including `edited` ensures title changes trigger a fresh
run with a fresh payload.

If the same workflow also runs expensive tests, title edits will rerun them too. For required checks, avoid guarding the
heavyweight job with `if: github.event.action != 'edited'`: GitHub reports skipped jobs as success, so a required `CI`
check can be satisfied without running tests.

Prefer two workflows: a small Intent workflow that includes `edited`, and a heavyweight CI workflow that only runs on
events that can affect code or commit history.

```yaml
# .github/workflows/intent.yml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

jobs:
  intent:
    runs-on: ubuntu-latest
    steps:
      - uses: goeselt/intent@v1
```

```yaml
# .github/workflows/ci.yml
on:
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
```

### Required Checks

When Intent and CI run as separate workflows, they are separate status checks. Add both to branch protection or
rulesets:

| Workflow | Job      | Required check name |
| -------- | -------- | ------------------- |
| `Intent` | `Intent` | `Intent / Intent`   |
| `CI`     | `CI`     | `CI / CI`           |

Requiring only `CI` does not require Intent to pass. A PR with a passing test suite and a failing Intent check can still
be mergeable if the ruleset only lists `CI`.

This is especially important when using the two-workflow pattern above. Do not replace it with a required CI job guarded
by `if: github.event.action != 'edited'`: skipped GitHub Actions jobs report success and can satisfy the required check
without running tests.

### Comment Behavior

`pr-comment` controls when Intent posts a sticky comment on the PR:

| Value                | Behavior                                                                          |
| -------------------- | --------------------------------------------------------------------------------- |
| `failures` (default) | Comments only when the PR author needs to act.                                    |
| `true` / `always`    | Creates or updates a sticky comment on every run.                                 |
| `false` / `never`    | No PR comment; validation results appear in annotations and the job summary only. |

### Squash Merge Commit Titles

Intent is designed for squash-merge workflows where the PR title becomes the release signal that lands on the default
branch. Configure GitHub to use the PR title as the squash commit title:

```bash
gh api --method PATCH repos/OWNER/REPO \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
```

This matters most for PRs with exactly one commit. With GitHub's `COMMIT_OR_PR_TITLE` setting, GitHub can keep the
single commit subject instead of the PR title. For example, a PR titled `fix!: update API` with one commit
`fix: update API` can be validated as a major bump before merge, but land on the default branch as a patch commit.
The later `push` release job only sees the default-branch commit history, so the major bump would be lost.

Intent warns in the PR comment when the PR title declares a stronger bump than the only commit in the PR. The warning is
non-blocking, but in `pr-comment: failures` mode it still creates a comment because the author needs to check the final
squash commit title before merging.

### Token and Annotation Fallback

Title and commit validation always run and set the job's exit code regardless of the comment outcome. If the token lacks
`pull-requests: write` or the comment cannot be posted for any reason, Intent does not fail the job -- it emits a
`::warning` annotation and continues. Validation results remain visible in the annotations panel and the job summary.

### Fork PRs

GitHub always issues a read-only `GITHUB_TOKEN` on `pull_request` events from forks, regardless of the `permissions:`
block. The comment step degrades to the annotation fallback described above for every fork PR.

To post comments on fork PRs, trigger on `pull_request_target` instead, which runs with the base repository's
permissions. Review GitHub's
[security guidance for `pull_request_target`](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
before doing so: the workflow then runs with write access against untrusted PR code, so never check out or execute the
fork's contents in that job.

---

## Version Resolution

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
```

### Fetch Depth

Version Resolution requires `fetch-depth: 0`. Shallow clones may not contain the tags and commit history needed to
resolve the next version. The default `fetch-depth: 1` used by build and test jobs will cause version resolution to fail
or produce incorrect results.

### Tag Namespace Protection

The latest matching Git tag is treated as release state. Anyone who can create or move matching tags can influence the
next resolved version. Protect the tag namespace used by `tag-prefix` and `release-scope` with repository rulesets or
branch-protection-equivalent tag rules, and make the release job the only workflow allowed to create or update those
tags.

| Configuration                                  | Tag pattern to protect |
| ---------------------------------------------- | ---------------------- |
| Default (`tag-prefix: v`)                      | `v*`                   |
| Scoped (`release-scope: cli`, `tag-prefix: v`) | `cli/v*`               |

Intent ignores malformed SemVer tags but cannot distinguish a legitimate release tag from an authorized-but-wrong tag
after checkout.

### Reserved Tags

GitHub can permanently reserve tag names that were used by immutable releases, even after the release and tag were
deleted. Git does not expose those reserved names during checkout, so Intent cannot discover them automatically.

Add known unusable tags to `reserved-tags`. Intent will skip them, emit a warning annotation, and use the next patch
version as a best-effort alternative. Entries must be full release tags for the configured namespace (`v1.2.3` by
default, or `cli/v1.2.3` with `release-scope: cli`).

`reserved-tags` accepts newlines, commas, or whitespace as separators:

```yaml
# All equivalent
reserved-tags: v1.2.3 v1.2.4
reserved-tags: v1.2.3, v1.2.4
reserved-tags: |
  v1.2.3
  v1.2.4
```

Invalid entries fail the action before any version outputs are written.

### Path Filters

`release-paths` and `release-ignore-paths` restrict which commits can contribute a version bump. Both accept Git
pathspecs, one per line.

| Input                  | Effect                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `release-paths`        | Only commits touching these paths can contribute a bump.                |
| `release-ignore-paths` | Commits touching only these paths are excluded from version resolution. |

Use `release-paths` for monorepo components where only changes to a specific subtree should trigger a release. Use
`release-ignore-paths` to exclude documentation or tooling changes that should never bump the version.

---

## Patterns

### Scoped Release (Monorepo)

Independently version a component within a monorepo. Tags become `cli/v1.2.3`; floating tags become `cli/v1` and
`cli/v1.2`.

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

Protect the `cli/v*` tag namespace in repository settings.

### Floating Docker Image Tags

Use the version outputs -- without the Git tag prefix or release scope -- to build and push Docker image tags:

```yaml
- uses: docker/build-push-action@v6
  if: steps.intent.outputs.release-needed == 'true'
  with:
    tags: |
      ghcr.io/example/my-image:${{ steps.intent.outputs.next-version }}
      ghcr.io/example/my-image:${{ steps.intent.outputs.major-version }}
      ghcr.io/example/my-image:${{ steps.intent.outputs.minor-version }}
```

### Reserved Tag Configuration

Three options depending on visibility requirements:

**Repository variable** (visible in settings, suitable for non-sensitive lists):

```yaml
- id: intent
  uses: goeselt/intent@v1
  with:
    reserved-tags: ${{ vars.INTENT_RESERVED_TAGS }}
```

**Repository secret** (hidden from settings UI):

```yaml
- id: intent
  uses: goeselt/intent@v1
  with:
    reserved-tags: ${{ secrets.INTENT_RESERVED_TAGS }}
```

**Inline** (suitable for small, stable lists):

```yaml
- id: intent
  uses: goeselt/intent@v1
  with:
    reserved-tags: |
      v1.2.3
```

### PR Comment Modes

**Always comment** -- create or update the sticky comment even when the PR passes, useful for audit trails:

```yaml
- uses: goeselt/intent@v1
  with:
    pr-comment: true
```

**Silent check** -- validation results appear in annotations and the job summary only; no PR comment is posted:

```yaml
- uses: goeselt/intent@v1
  with:
    pr-comment: false
```
