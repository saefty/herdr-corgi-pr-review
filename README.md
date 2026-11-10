# PR review for Herdr

A Herdr mod for reviewing pull requests next to your agents. A side panel shows the focused branch's diff (or any
PR), lets you comment on lines and send the comments to the agent that wrote the code. A full-window review
layout adds an AI analysis that walks you through the PR by risk and layer, reviewers (Claude code review,
security review, optionally Codex) whose findings you can send to the agent to fix and then verify, an
architecture picture, a security blast radius, CI checks, related PRs, and go-to-definition in the diff.

![The review layout's overview of a demo PR](preview.png)

![Open a PR, read its layers, the architecture impact and the blast radius, then jump into the diff](docs/screenshots/walkthrough.gif)

| | |
|---|---|
| ![Layers: the AI's walkthrough by layer, with a picture per layer](docs/screenshots/layers.png) | ![Architecture impact: every connection on its own lane, numbered, with a legend](docs/screenshots/architecture-impact.png) |
| ![Security blast radius: related context and how it links to the changes](docs/screenshots/security-blast-radius.png) | ![Findings from the reviewers, with Fix and Discuss](docs/screenshots/findings.png) |
| ![The diff with example values inline, an AI suggestion and a finding](docs/screenshots/diff-inline-values.png) | ![Go to definition in the diff through a language server](docs/screenshots/go-to-definition.png) |
| ![The panel's PR sources with triage](docs/screenshots/panel-pr-sources.png) | ![Setup: which programs are there and how to install the rest](docs/screenshots/panel-setup.png) |

The screenshots show an invented demo project (`demo/`), not a real repository.

## What's in here

- `mods/pr-review/`: the mod (the panel, and the review layout's two parts).
- `layouts/review.json`: the review layout the panel's "Review" button switches to.
- `RECIPE.md`: the brief to build it from scratch.

## Requirements

A mod can't install programs. The panel's **Setup** (PRs ▾ → Setup, and by itself on first open when something
required is missing) checks each one, says what it enables, and opens a terminal with the install command typed
in but not run.

| Program | Needed for | macOS | Linux |
|---|---|---|---|
| `git` | diffs, checkouts | `brew install git` | `sudo apt install git` |
| `gh` (logged in) | PR lists, diffs, CI checks, clones | `brew install gh`, `gh auth login` | `sudo apt install gh` |
| `claude` (logged in) | the AI analysis, reviewers, triage, fix checks | `npm install -g @anthropic-ai/claude-code` | same |
| `python3` | the helper scripts (standard library only) | `brew install python` | `sudo apt install python3` |
| `codex` (optional) | the Codex reviewer, offered only when installed | `npm install -g @openai/codex` | same |
| `acli` (optional) | the Jira ticket a PR names, in the task check | `brew tap atlassian/homebrew-acli && brew install acli` | see Atlassian's docs |

Optional language servers turn on go-to-definition and hover for their language; a missing one only turns it off
for that language: `typescript-language-server` + `tsc` (TypeScript, JavaScript), `pyright-langserver` (Python),
`gopls` (Go), `rust-analyzer` (Rust), `jdtls` (Java), `terraform-ls` (Terraform), `clangd` (C, C++).

The reviewers use Claude Code's `/security-review` and a `/code-review` command; without the command in your
Claude setup the same review runs as a plain prompt.

## Install

Copy `mods/pr-review` to `~/.config/herdr-app/mods/` and `layouts/review.json` (with `review.svg`) to
`~/.config/herdr-app/layouts/`, then run `herdr-app check ~/.config/herdr-app/mods/pr-review`. The panel docks on
the right the first time Herdr sees it.

It runs programs (`git`, `gh`, `claude`, `python3`, language servers), reaches GitHub through `gh`, and reads your
Claude session transcripts (`~/.claude/projects`) to list PRs your sessions created. LLM calls only happen when you
click (Analyze, a reviewer, Triage, Verify fixes). Its data lives in `~/.config/herdr-app/pr-data/`.

## Settings

Optional, in `~/.config/herdr-app/pr-review.config.json`:

```json
{ "language": "English", "cloneRoot": "~/code", "globalRules": "PR titles follow Conventional Commits.", "ledger": null }
```

`language` is what the AI writes in; `cloneRoot` is where PR checkouts are cloned on request; `globalRules` are
conventions every PR is checked against; `ledger` is a folder for a JSONL usage ledger of every LLM call.

## Plug-ins

Other mods can add contexts (groups of PRs with their own tag, env vars, clone folder and view filter), mirror the
review list elsewhere, and hook into Go to and a chat bar. See `mods/pr-review/PROVIDERS.md`.

## Demo

`sh demo/setup.sh` builds an invented repo (`acme/bookshelf`, PR #7 "feat(loans): add due-date reminders") with a
local stand-in for its GitHub remote, and a separate Herdr home in `demo/home` whose pr-review data is seeded from
`demo/fixtures/` (the analysis, two findings, related PRs and checks, PR lists, triage). Open a second Herdr window
on it with `HERDR_APP_HOME="$PWD/demo/home"`, add a space in `demo/bookshelf` there, and switch it to the `review`
(or `demo-panel`) layout: everything shows without LLM calls, and GitHub is only asked when a seeded PR list is
older than 3 minutes (↻). The commands `pr-review.page:arch`, `pr-review.step:1`,
`pr-review.def:<path>:<line>:<name>`, `pr-review.source:repo` and `pr-review.setup` drive it from
`herdr-app do`.

## Tests

`cd mods/pr-review && for f in test_*.mjs; do node $f; done && for f in test_*.py; do python3 $f; done`
(no network; `LIVE=1 node test_defs.mjs` also asks pyright).

## Security: other people's code

Language servers can run code from the repository they index (Gradle/Maven build scripts, Rust build scripts and
proc macros, a project-local TypeScript). pr-review therefore treats a PR as **untrusted** unless it is your own
branch, a PR from your own sessions, or authored by your GitHub login. For untrusted PRs the language servers start
in **safe mode** (Java without Gradle/Maven import, the global TypeScript only, Go without module downloads or cgo,
and no rust-analyzer at all, since a repo's toolchain and cargo config can run its own programs)
and are not warmed up; go-to-definition may find less. The review header shows **Safe mode · Trust code** to opt a
PR into full mode.
