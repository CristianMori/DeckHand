---
title: The docs/architect convention
updated: 2026-11-04
status: current
---

# The docs/architect convention

What every architect session in a Deckhand fleet keeps, and how the hub enforces it. This file is the authoritative copy; the rules texts the hub gives architects point here (on GitHub: github.com/CristianMori/DeckHand/blob/main/docs/architect-convention.md).

Every ARCHITECT session keeps a `docs/architect/` folder in its own project. It is the single source of truth for the project's architecture and history. The folder is **not tracked in git**: it is listed in the project's `.gitignore`, never committed, and moves between machines with Deckhand's own folder sync. It lives only in the architect's working folder; a worker's worktree, made from a commit, doesn't have it.

If you are NOT an architect: nothing to do. This applies to you if the user makes you one.

## The folder

```
docs/architect/README.md             what the project is, how to read the folder, a timeline linking the notes
docs/architect/architecture.md      what is true NOW
docs/architect/notes/YYYY-MM-DD.md  one file per day with real work, append-only history
docs/architect/assets/             screenshots
```

Create it (and add `docs/architect/` to the project's `.gitignore`) the moment you become a project's architect: the hub refuses to start workers until `architecture.md` exists in your working folder.

**architecture.md**: YAML front matter (title, updated, status: current — true as of build/version N), then a "# \<Project> architecture" title and one line of branch state. Then "## Summary" (under ~3,000 characters: the essentials you must never lose; the hub refeeds it first after a compaction, and sends it to cross-machine workers in place of the folder they can't read), "## In flight" (one line per open worker branch, the line dh_start_worker hands you, or "_Nothing in flight._"), "## What \<project> is", "## Design principles" (a table: Principle | Why | Decided, linking to the note), one "##" section per subsystem (what it is, how it works, WHY, what was rejected), and "## Known issues". Diagrams are ```mermaid blocks (flowchart / sequenceDiagram / stateDiagram-v2), one idea each, checked to render. Anything that exists only on an unmerged branch is marked "⎇ \<branch> (not merged)"; the marker comes off when the branch merges, and a dropped branch's text goes, with a note saying why.

**notes/YYYY-MM-DD.md**: front matter (title, date, status: history, branches, builds), then "# YYYY-MM-DD — \<title>". Then one "##" section per request: the user's words quoted verbatim as "> ..." quotes, "**Decided:**" (options weighed, and why), "**Built (`commit`, build/version):**" (what happened and what was checked; say what is unverified), "**Open:**". Append only; a change of mind is a new section that links back.

## Rules for both documents

- Standard relative Markdown links only (no \[\[wikilinks]]), so the folder reads the same dropped into Obsidian or any Markdown viewer, and nothing in it links outside it.
- Update the documents **at the same time** as each decision or merge. They are untracked, so no commit carries them: the discipline is yours, and the hub reminds you when you slip (see below).
- **Never** put secrets, keys, tokens, phone numbers, IP addresses or personal email addresses in them — the folder is out of git, but it still syncs between the fleet's machines. No real machine names either: use roles ("Windows desktop hub", "Linux VPS hub", "Mac build node"), replacing hostnames even inside quotes.

## Who writes it

The architect, and only the architect. A worker's worktree is made from a commit, so it has no `docs/architect/` and must never create one: its briefing gives it the absolute path of the lead's `architecture.md` to **read** (same machine), or the `## Summary` inlined (another machine). Every worker and sub-architect report ends with a "Docs:" section — what `architecture.md` or today's note should now say because of the work, or "Docs: no change, because …" — and the lead writes the documents from it.

## What the hub enforces

- **No worker without architecture.** `dh_start_worker` / `dh_start_subarchitect` refuse while `docs/architect/architecture.md` does not exist in the lead's working folder on the lead's machine (leads outside git are exempt). For a cross-machine worker the lead's hub decides before asking the host. A successful start hands the lead a ready-made "In flight" line to paste into `architecture.md`.
- **No silent merges.** When a worker starts, the hub fingerprints the lead's docs (a hash of `architecture.md` plus the notes files' names and sizes). `dh_remove_worker` on a merged branch is refused **once** when that fingerprint is unchanged and the report doesn't say "Docs: no change"; removing it again within 10 minutes goes through. A cross-machine lead's hub compares the fingerprint itself, since the docs are on its machine.
- **Compaction gives the memory back.** After a compaction or resume the hub re-feeds the working `architecture.md` (the `## Summary` first and always in full) plus the newest two notes, clipped to fit.
- **The card says how far docs lag.** `docsBehind` counts the commits on the lead's branch made after any file in `docs/architect/` was last modified; the dashboard card shows "docs N behind" from N ≥ 3.

## Seeding the notes from real history

Pull the user's own messages out of your project's conversation transcripts on your machine (`~/.claude/projects/<your project folder>/*.jsonl`; entries of type "user" with text content, skipping tool results and system reminders) with a small script, and match them against `git log` for commits and dates. The transcripts contain secrets: scan everything you write (`hm_`, `hmb_`, keys, `Bearer`, tokens, phone-like digit runs, IPs, hostnames) before you save it. If the project is large, hand the survey to a worker — but write a minimal `architecture.md` first, since workers won't start without one.
