# Cloud agents: GitHub PRs as CultPodcasts

**Canonical agent rule:** **`AGENTS.md`** § *Primary guardrails* §9.

New Cursor cloud agents often **push** a branch, then fail to open a PR with `must be a collaborator` or `Resource not accessible by integration`. That is expected. Do **not** stop at a compare URL.

## Why it fails

| Identity | What it can do on this repository |
|----------|-----------------------------------------------|
| Default cloud-agent `cursor` GitHub App token | `git push` of `cursor/*` branches. **Cannot** create issues or PRs. |
| **`cultpodcasts`** (CultPodcastsBot) | Admin collaborator. Historical PRs are authored as this user. **Use this to open PRs.** |
| `erkinkas` | Write collaborator. Not the PR author for agent work. |

`ManagePullRequest` uses the Cursor App identity. When it returns **must be a collaborator**, switch to a CultPodcasts `gh` session. Do not treat that error as a hard stop.

## What agents must do

1. Confirm the working branch is pushed (`git push -u origin <branch>`).
2. Try `ManagePullRequest` once if that tool is available.
3. If it fails with collaborator / integration 403, **start GitHub device login** and give the operator the code. Do not wait for them to invent a PAT.

```bash
gh auth login --hostname github.com --git-protocol https --web \
  --scopes repo,read:org,workflow --insecure-storage
```

Answer **Yes** to “Authenticate Git with your GitHub credentials?” then send the operator:

- URL: https://github.com/login/device
- The one-time code printed by `gh` (for example `ABCD-1234`)

They must sign in as **CultPodcasts** (not a personal account) and authorize the CLI. Codes expire in about 15 minutes.

4. After they confirm, verify and create the PR:

```bash
gh auth switch --user cultpodcasts
gh auth status
# Must show: Logged in to github.com account cultpodcasts

gh pr create --base main --head <branch> \
  --title "<title>" --body "<body>"
```

5. Later updates to that PR may use `gh pr edit` / `gh pr comment` as `cultpodcasts` if `ManagePullRequest` still fails.

## Checks

```bash
gh api user --jq .login
# cultpodcasts

gh pr view --head <branch> --json url,author
```

## Do not

- Leave only a compare URL after a collaborator failure.
- Invite `cursor` as a collaborator or request GitHub access “as CultPodcasts” — that user **already has admin**.
- Use the `cursor` App token (`ghs_…`) or `gh api …/pulls` with the git-remote `x-access-token` to create PRs (403).
- Device-login as a personal GitHub user unless the operator explicitly says to.
