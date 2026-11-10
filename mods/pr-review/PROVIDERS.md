# PR review: the plug-in contract (version 1)

The rules every mod in the herdr-corgi set shares (announcing, requests, providers, the context hook,
versions) are in [CONVENTIONS.md](https://github.com/saefty/herdr-corgi/blob/main/CONVENTIONS.md). This page has
what is specific to this mod.

pr-review works on its own. Everything here is optional: other mods add to it through shared state only, and
pr-review never reads another mod's files. Load order doesn't matter: pr-review reads these keys each time it
renders, and a plug-in can write them whether or not pr-review is installed.

## 1. Contexts: `pr-review.contexts`

A context is an opaque grouping of PRs: a client, a profile, a GitHub account, a work/personal split. A plug-in
supplies them; pr-review only uses what the document says. Without the key there is one implicit context,
`"default"`: no tags, no filtering, no extra env, clones in the `cloneRoot` setting.

```js
setShared("pr-review.contexts", {
  default: "blue",                                     // a space or PR nothing else matches
  spaces: { "<space id>": "red" },                     // optional: context per space
  rules: [                                             // optional: first match wins
    { path: "~/code/red", context: "red" },            //   a folder and everything under it (case-insensitive)
    { remote: "github\\.com[:/]red-org/", context: "red" }, // a case-insensitive regex on the repo URL
  ],
  contexts: {
    blue: {
      label: "Blue",                                   // the tag text (tags show only with two or more contexts)
      name: "the Blue profile",                        // optional: for sentences ("This PR belongs to …")
      color: "ansi4",                                  // a theme color name or #hex
      env: { CLAUDE_CONFIG_DIR: null },                // optional: env for claude/gh/git calls; null unsets
      cloneRoot: "~/code/blue",                        // optional: where this context's clones go
      show: { key: "mymod.view", values: ["all", "blue"] }, // optional: shown while shared(key) is one of these
      reveal: { key: "mymod.view", value: "blue" },    // optional: what "Switch to Blue" sets
      tickets: false,                                  // optional: skip the Jira lookup for this context
    },
    red: { label: "Red", color: "ansi5", env: { CLAUDE_CONFIG_DIR: "~/.claude-red" }, cloneRoot: "~/code/red" },
  },
});
```

- **A PR's context**: the one it was listed with, else the rules on its folder and repo URL, else (for a repo's
  PR list) the space's, else `default`. An id the document doesn't know is ignored.
- **A space's context**: `spaces[id]`, else `default`.
- **env** prefixes every program pr-review starts for that context (`env -u X Y=v …`): new Claude tabs,
  `claude --resume`, the analysis, reviewers, triage, fix verification and clones. The Claude config folder
  (`CLAUDE_CONFIG_DIR`, else `~/.claude`) of each context is also where pr-review looks for PRs made in Claude
  sessions ("Mine").
- **show / reveal**: lists and "in progress" show only the contexts the view shows. A picked PR the view hides
  gets a banner with "Switch to <label>" (when `reveal` is set).
- **Clones**: an existing clone is looked for under every context's `cloneRoot` and the `cloneRoot` setting; a new
  one goes to the PR's context's `cloneRoot`, else the setting.

## 2. What pr-review publishes

| Key | Shape | When |
|---|---|---|
| `review.open` | `[{url, number, repo, title, context, status: "in-progress" \| "sent", startedAt, lastTouched, headSha, progress: {steps, stepsChecked, files, filesViewed, comments, findingsOpen}, triage: {priority, why, chips}, target}]` | reviews not done, newest first; on every change |
| `review.registry` | `{at, touched: url, entries: [same, done ones too]}` | every registry change (1.5 s after the last edit); for plug-ins that mirror reviews elsewhere (a to-do list, a day plan) |
| `review.target` | a PR (`{url, repo, number, title, headSha?, context?, …}`) | the PR the review layout shows |
| `review.meta` | `{url, pending, model, busy, error, shown: {model, cost, exact, mergeRisk, effort}}` | the analysis state and the pending comment count, for the bar |
| `review.layout` | `"review"` or `"pr-review"` | the review layout's name (`"pr-review"` when another layout already had the name `review`) |
| `review.worktree` | `{url, head, path}` | the checkout of the PR head |
| `pr-review.setup` | `{at, os, found: {program: path \| null}, auth: {gh, claude}}` | after a Setup check |

**Resume a review from any mod**: `setShared("review.target", entry.target); run("layout.switch", { name: shared("review.layout") ?? "review" })`. The layout is installed into `layouts/` the first time a review is opened from the panel.

## 3. Go to (optional)

When the Go to mod is installed (`goto.api`), PR links there become "Review PR #n" and reviews in progress are
findable: pr-review registers the provider `review`, writes `goto.handlers.review` and `goto.items.review`, and
takes a handed-over PR from `pr.goto` (`{url}`). Without Go to these keys are simply unused.

## 4. Chat bar (optional)

"Discuss in chat" drafts a finding for the PR's agent without sending it. When a chat mod sets
`chatbar.api = {version: 1}`, pr-review hands the draft over instead of opening its own window:

```js
setShared("chatbar.request", { action: "draft", terminal: "t7", text: "…", from: "pr-review", at: Date.now() });
```

The chat mod opens that agent's bubble with `text` in the reply field (not sent). Without `chatbar.api`,
pr-review opens the agent's terminal in a window and pastes the text there (via the clipboard), as before.

## 5. Settings: `pr-review.config.json` (in the Herdr app home)

All keys optional.

```json
{
  "language": "English",
  "cloneRoot": "~/code",
  "globalRules": "PR titles follow Conventional Commits: `type(scope): subject`.",
  "ledger": "~/.local/share/llm-usage",
  "sessionTitles": "~/path/to/titles.json"
}
```

- `language`: what the AI writes in (analysis, reviewer verdicts, fix checks) and asks your agent to answer in.
  Prompts are English either way. Default English.
- `cloneRoot`: where clones go when no context says otherwise. Default `~/code`.
- `globalRules`: conventions every PR is checked against, next to the repo's own CLAUDE.md, AGENTS.md,
  CONTRIBUTING.md, `.github/*instructions*.md` and ADRs.
- `ledger`: a folder for a usage ledger. Each LLM call appends one line to `usage-YYYY-MM.jsonl` there:
  `{at, feature, account (the context id), model, cost, tokens, ms, ok, tool}`. The newest 24 months are kept.
  Unset: no ledger.
- `sessionTitles`: a JSON file `{<Claude session id>: {title}}` with better titles for the "Mine" list.

Feature names in the ledger: `Review analysis`, `Review analysis (since last review)`, `Claude code review`,
`Security review`, `Codex review`, `PR triage`, `PR fix verification`.

## 6. Programs

Setup (PRs ▾ → Setup) checks each one and offers the install command; nothing is installed without you pressing
Enter in the terminal it opens.

- Required: `git`, `gh` (logged in), `claude` (logged in), `python3`.
- Optional: `codex` (the Codex reviewer is offered only when it is on PATH), `acli` (the Jira ticket a PR names).
- The reviewers use Claude Code's `/security-review` and a `/code-review` command; when a command is missing in
  your Claude setup, the same review runs as a plain prompt.
- Language servers, for go-to-definition and hover in the diff (each one only turns that language on):
  `typescript-language-server` + `tsc` (TypeScript, JavaScript), `pyright-langserver` (Python), `gopls` (Go),
  `rust-analyzer` (Rust), `jdtls` (Java), `terraform-ls` (Terraform), `clangd` (C, C++). They are found on PATH
  plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin` and `~/go/bin`; their indexes live under
  `pr-data/` (bounded, oldest removed).
