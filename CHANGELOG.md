# Changelog

## 0.8.0 (2026-11-12)

### Features

- arch: stack a picture wider than the view in bands, and set a cramped edge label on the roomier side
- arch: a Wrap switch beside Fit, bands or one row to scroll
- arch: wrap by itself only while Ask is open
- arch: a click on a card shows what it does and what the PR changes in it
- review: run Explain for several cards at once, each card keeps its own result
- arch: the card panel names the card's file and its links to other cards
- review: architecture cards carry their name in the code, details name the file
- arch: card details and Explain answers in markdown, bullets with bold changes and code names

### Fixes

- review: keep big PRs inside Herdr's ~50 ms script slice
- arch: give each self-loop its own row beside the card, clear of its neighbours
- arch: wrap only when switched on, never by itself

## 0.7.0 (2026-11-11)

### Features

- arch: bigger jump chips with the call's number as a badge and a clearer tooltip
- review: fold and open files by themselves while scrolling

### Fixes

- arch: jump chips as wide as their text

## 0.6.0 (2026-11-11)

### Features

- review: fold lock files and changes over 400 lines when a review opens
- review: files past the list's room fold by themselves; opening one folds those opened longest ago

### Fixes

- panel: review PRs over 300 files via the pull request files API
- review: keep row arrays across renders so a big diff is never hashed in render
- review: fold files past the virtual list's 10000-item limit instead of crashing

### Other

- perf(panel): cache big PR diffs in parts

## 0.5.0 (2026-11-11)

### Features

- review: hand finished fixes to the PR's agent

### Fixes

- review: one scroll axis per gesture in the flow, state and blast pictures

## 0.4.0 (2026-11-11)

### Features

- ui: explain controls with hover texts, rename the Mine chip to Yours

### Fixes

- review: give the two header rows more room

## 0.3.0 (2026-11-11)

### Features

- review: resizable layers column, wider by default
- review: ask about the architecture
- panel: split the side panel into picking and a chosen PR
- review: draw flow pictures like Architecture impact
- review: keep sent comments as threads with agent replies
- review: fix comments with a sub-agent in its own worktree
- panel: show replies and fixed threads in the in-progress line
- review: Ask in a drawer, pinned answers as private notes
- review: compact comment cards, a floating selection bar, a two-row header
- review: steady sideways scrolling and a Fit view for wide pictures
- review: a Comments tab and a Show switch for comment kinds
- review: let the analysis choose its scope for big PRs
- review: drill down into a card or a layer
- review: explore a topic in existing code without a PR

### Fixes

- review: size the keyboard shortcuts popup to its content
- review: open the comment box from a selection, keep letters in inputs
- review: one channel per target, badges in reading order, Ask on demand
- llm: retry once when the claude binary is briefly missing
- review: say who posts where, post no empty body, make the deep review easy to find
- review: explore folders start in Restricted Mode

### Other

- docs: describe Ask, drill-down, Explore, comment threads and Fix

## 0.2.1 (2026-11-10)

### Fixes

- review: bound the diagram layout search so big pictures render in time

## 0.2.0 (2026-11-10)

### Features

- review: readable architecture impact for many edges
- review: tell spec from implemented, refresh diagrams on demand

### Other

- docs: refresh the architecture impact screenshot and describe the new pictures

## 0.1.1 (2026-11-10)

### Fixes

- Review PR from Go to works while the review layout is open

### Other

- docs: name it as part of Corgi
- docs: use the GitHub link for agent installs
- docs: highlight the changeset, architecture and sample values

## 0.1.0 — initial release

- First tagged release.
