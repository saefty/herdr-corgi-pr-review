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

## Use cases

- **Your agent opened a PR.** It shows up in the panel with the session that made it. You read the diff, comment on
  lines, and send the comments back to that agent, which picks up where it left off.
- **A colleague asked you for a review.** Pick it under *Review requested*, open it full size, and let the AI walk
  you through it: what the PR wants, how behaviour changes, which layer to read first and why.
- **A big PR lands on a Friday.** The overview gives you merge risk, review effort, blockers and failed checks
  before you open a file. The layers group 40 files into five steps you can tick off.
- **The author pushed again.** You see only what changed since your last review, and one click re-analyses just
  that part.
- **You want a second opinion.** Run a Claude code review, a security review or Codex. Findings land on their lines;
  send one to the agent with *Fix*, then *Verify* checks the new commit.
- **You don't know the codebase.** Hover a name or ⌘-click it to read its definition, see example values next to
  the changed lines, and look at the architecture picture to see which services the change touches.

## Features

- Panel: PRs from your sessions, the repo you're in, or review requests, with a one-line triage per PR.
- Review layout: overview (intent, behaviour, risk, effort, blockers, pre-merge checks), layers in risk or reading
  order with check questions, an architecture impact diagram, a security blast radius, and related PRs.
- Diff: syntax highlighting, go-to-definition through real language servers, inline example values, collapsed
  context you can open, line and range comments.
- Reviewers: Claude code review, security review, Codex (when installed), each finding with Discuss, Fix and Verify.
- Incremental: "since your last review" view and analysis.
- Model per review (Haiku, Sonnet, Opus); LLM calls only on click.
- Restricted Mode for other people's code (see below).
- Optional hooks for other mods: contexts (accounts, clone folders), a Go to palette, a chat bar.

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

## Restricted Mode

Language servers can run code from the repo they index: Gradle and Maven build scripts, Rust build scripts and proc
macros, a toolchain or cargo config, a TypeScript copy in node_modules. pr-review trusts your own branches, PRs from
your sessions and PRs you authored. For anyone else's PR it asks first, as VS Code does when you open a folder:

- **Trust this PR** or **Trust all PRs in owner/repo**: language servers run as usual.
- **Stay in Restricted Mode**: Java skips the build import, TypeScript uses your global install, Go downloads nothing
  and skips cgo, and rust-analyzer doesn't start. Go-to-definition finds less. The diff, the reviewers and the AI
  analysis work the same.

The header shows **Restricted Mode · Trust** until you trust the PR.
