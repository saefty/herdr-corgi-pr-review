#!/bin/sh
# Builds the demo: an invented repo (acme/bookshelf, branch feat/due-reminders, "PR #7") with a local stand-in for its
# GitHub remote, and a separate Herdr home (demo/home) whose pr-review caches are seeded from demo/fixtures, so the
# panel and the review layout show a full review without network or LLM calls. Then:
#   HERDR_APP_HOME="$PWD/demo/home" /path/to/Herdr     (a second window; switch it to the "review" layout)
# Run from the repo root. Rebuilding is safe: demo/bookshelf, demo/remotes and demo/home are recreated.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
rm -rf "$here/bookshelf" "$here/remotes" "$here/home"

git init -q -b main "$here/bookshelf"
cd "$here/bookshelf"
git config user.name "Demo"; git config user.email "demo@example.com"
cp -R "$here/fixtures/repo/base/." .
git add -A; GIT_COMMITTER_DATE="2026-03-01T10:00:00Z" git commit -q --date "2026-03-01T10:00:00Z" -m "chore: loans and mail"
git checkout -q -b feat/due-reminders
cp -R "$here/fixtures/repo/head/." .
git add -A; GIT_COMMITTER_DATE="2026-03-09T16:30:00Z" git commit -q --date "2026-03-09T16:30:00Z" -m "feat(loans): add due-date reminders"
head=$(git rev-parse HEAD)
# The "GitHub" remote is a local bare repo whose path ends in github.com/acme/bookshelf, with the PR's head ref.
remote="$here/remotes/github.com/acme/bookshelf.git"
git clone -q --bare . "$remote"
git -C "$remote" update-ref refs/pull/7/head "$head"
git remote add origin "$remote"
git fetch -q origin
git remote set-head origin main

home="$here/home"
mkdir -p "$home/mods" "$home/layouts"
cp -R "$root/mods/pr-review" "$home/mods/"
cp "$here/layouts/demo-panel.json" "$home/layouts/"
# The review layout as the mod installs it on first use (startReview), so the demo can switch to it right away.
cp "$root/mods/pr-review/review-layout.json" "$home/layouts/review.json"
printf '{ "appearance": "dark", "telemetry": false }\n' > "$home/settings.json"
# dryRun: "Submit review" writes the GitHub payload to pr-data/review-dry-run.json instead of posting (acme/bookshelf is invented).
printf '{ "cloneRoot": "%s", "language": "English", "dryRun": true }\n' "$here" > "$home/pr-review.config.json"
node "$here/seed.mjs" "$home" "$here/bookshelf" "$head"
echo "demo ready: HERDR_APP_HOME=$home"
