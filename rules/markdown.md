---
paths:
  - "**/*.md"
  - "**/*.mdx"
---

# Markdown

Editing Markdown usually means writing prose, so the writing rules apply as much as the formatting rules below. Find the project's writing conventions before you write.

## Project conventions first

If the repo has a Markdown linter or formatter config (`.markdownlint*`, `.remarkrc*`, `.prettierrc*`, a `lint-md` script), follow it and run it on changed files. Otherwise match the style already in the file: wrapping, list markers, heading case, table style.

## Defaults for new files

- GitHub-flavored Markdown. One `#` title, then `##` sections. Don't skip levels.
- Sentence-case headings.
- Don't hard-wrap prose. Put each paragraph on one line.
- `-` for bullets.
- Fenced code blocks always carry a language tag (`bash`, `json`, `ts`, …). Shell blocks hold commands only: no `$` prompt, no interleaved output.
- Inline code for file paths, commands, flags, env vars, and identifiers.
- Tables for comparisons across the same attributes. Keep cells short.

## Links

- Files in the same repo: relative links (`[git.md](rules/git.md)`).
- Sections: link with the heading's auto-generated anchor, such as `[Links](#links)` in the same file, `[Agents](README.md#agents)` in another. The anchor is the heading text lowercased, with spaces turned into `-` and punctuation other than `-` and `_` dropped. Don't invent another reference scheme (`§3.2`, `{#id}`, `[[name]]`, `^ref`, "see above"). Only use HTML `<a id>` tags when no heading fits (such as when two section headers have the same text and we need to differentiate).
- After renaming a heading, fix links to its anchor.
- Issues and PRs: full URLs, never a bare `#123`. It resolves against whatever repo renders it, which is often a fork.
- After moving or renaming a file, fix links that point to it.

## Scope

- Don't add boilerplate unasked: tables of contents, badges, "Contributing"/"License" sections, emoji headings.
- When editing an existing document, change only what the task needs. Don't reformat untouched sections.
