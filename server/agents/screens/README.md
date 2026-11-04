# Real screen captures

Plain-text screens of the real TUIs, rendered through node-pty + @xterm/headless
— the same mirror the hub keeps per session — and used by `server/composer.test.ts`
to pin down how each engine draws an empty versus non-empty composer and its
startup dialogs. Captured 2026-11-04 (Claude Code v2.1.318, Codex CLI); user
names and temp-dir suffixes scrubbed. Re-capture when a TUI redesign breaks the
tests, not by hand-editing these files.

- `claude-startup.txt` — the folder trust dialog ("Quick safety check: Is this a project you created or one you trust?")
- `claude-empty.txt` — empty composer, with the rotating `❯ Try "…"` placeholder hint
- `claude-draft.txt` — the composer holding typed text
- `claude-hub-working.txt` — a hub-spawned session mid-turn: spinner above an empty `>` composer (from a live hub mirror)
- `codex-startup.txt` / `codex-dialog.txt` — the "Hooks need review" startup menu
- `codex-empty.txt` — empty composer ("Ask Codex to do anything" placeholder)
- `codex-draft.txt` — the composer holding typed text
