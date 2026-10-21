# Contributing to Gentle Voice

External code changes follow one path: an Issue, a classification label, a linked pull request, CI, maintainer review, then merge.

`approved` means the maintainer accepted the proposal. It is not required to open a pull request, and it does not authorize the merge by itself.

## Quick path

1. Open an Issue with a form and a classification label.
2. Link a pull request to that open Issue with `Closes #123`.
3. Let CI finish on Ubuntu, macOS, and Windows.
4. Wait for the maintainer to review and merge.

The repository owner is the only person who can merge.

## Issues

Every external code change starts from an Issue in `efolchmontiel/gentle-voice`. The Issue is opened before the pull request. It describes the problem or the proposal, and it carries at least one classification label.

| Classification | Use |
| --- | --- |
| `bug` | A defect |
| `enhancement` | A new capability |
| `documentation` | Docs only |
| `performance` | Speed or resource use |
| `refactor` | A restructure that keeps behavior |
| `security` | A security defect that is safe to discuss in public |

These labels do not classify the Issue. They add context:

| Auxiliary | Use | Who applies it |
| --- | --- | --- |
| `needs triage` | Not classified yet | Maintainer |
| `good first issue` | Suitable for a new contributor | Maintainer |
| `help wanted` | Outside contribution is welcome | Maintainer |
| `approved` | The maintainer reviewed and accepted the proposal | Maintainer only |

`approved` is optional. A pull request may exist before it is applied. Merge still needs the checks below and the maintainer's review.

Sensitive vulnerabilities do not use a public Issue. Use [private security reporting](https://github.com/efolchmontiel/gentle-voice/security/advisories/new). That page accepts reports only after the maintainer enables private vulnerability reporting.

## Pull requests

The pull request target is `main`. The body contains a closing reference to an Issue in this repository:

```text
Closes #123
```

`Closes #123` must name an open Issue. A pull request number, a placeholder, or an Issue in another repository does not count. The linked Issue needs one classification label from the table above. `approved` does not replace that label.

The automatic check reads the pull request body from GitHub. Editing the template, or deleting a heading, does not skip it.

CI from `.github/workflows/ci.yml` runs the test suite on Ubuntu, macOS, and Windows. Those jobs stay required. The linked-issue check does not replace them and does not review the change.

## Administrative exception

The owner may do administrative maintenance without an Issue. The pull request body must contain this line on its own:

```text
Administrative-exception: owner-maintenance
```

GitHub records the author as `OWNER`. Anyone else who adds that line fails the check. The exception does not skip CI, review, or a bad `Closes #123` when one is present.

## Merge

The maintainer merges after:

- the linked Issue is valid, or the administrative exception applies
- Ubuntu, macOS, and Windows CI have passed
- the linked-issue check has passed
- review conversations are resolved
- the maintainer accepts the change

A green CI run is not merge permission for anyone else. Do not grant Write, Maintain, or Admin to another account if the owner should remain the only person who can merge.

## Commit attribution

Commit authorship stays with the person who makes the commit. Cursor is not a co-author.

The IDE setting is **Commit Attribution** ("Mark Agent commits as 'Made with Cursor'") under **Source Control**. The CLI key is `attribution.attributeCommitsToAgent` in `~/.cursor/cli-config.json`. Turn both off, and turn off **PR Attribution** the same way.

A local `commit-msg` hook may remove only these exact trailers:

```text
Co-authored-by: Cursor <cursoragent@cursor.com>
Made-with: Cursor
```

The sample for this repository is [scripts/git-hooks/commit-msg](scripts/git-hooks/commit-msg). It does not change the author and it does not remove any other trailer. Cloud agents that commit outside this clone can still add the trailer when their own attribution setting is on. A Markdown rule does not stop the tool that runs Git.

Published history is not rewritten to hide old trailers.
