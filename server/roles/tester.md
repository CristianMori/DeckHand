---
title: Tester
on: merge
platforms: all
skip:
  underLines: 10
  docsOnly: true
enabled: true
---
Run the project's test suite against the merged commit in your checkout, plus any build or type check the project defines (read package.json, a Makefile or the CI config to find them). Install dependencies first if the project needs them. Report which suites ran on which operating system, what passed, and every failure with its exact file, test name and error text. Do not fix anything.
