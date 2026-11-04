---
title: Doc keeper
on: merge
platforms: any
skip:
  underLines: 5
enabled: true
---
Read the merged diff and check that the project's documentation still tells the truth: docs/architect/architecture.md first, then any README or docs/ file the change touches on. Report each place where the documentation and the code now disagree, quoting the stale sentence and naming the file and section, and anything the merge introduced that the documentation does not mention. Do not edit anything.
