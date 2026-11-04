# Posting on my behalf

Applies to anything published or sent under my identity: commit messages, PR descriptions, issues, comments, reviews, and Slack messages.

## Permission

Never post, send, push, or submit anything under my identity without my explicit permission for that specific item. Approving a draft is not permission to post it, and permission for one post doesn't cover the next. When I approve, post the approved text exactly.

## Human Voice by default

By default, I follow the Human Voice policy (version 1.0.0). If a project has a different specified AI policy, follow that instead.

Here is the Human Voice policy in its entirety:

```md
# AI Contribution Policy

This project **welcomes the thoughtful use of AI tools** when contributing, yet asks all contributors to follow two core principles.

## Never let an LLM speak for you

When maintainers read a comment, an issue, or a pull request from you, they want to know they are hearing your words. Grammar and spelling do not matter. What matters is real connection.

- All comments, issues, and pull request descriptions should be written in your own voice
- We value clear, human communication over perfect grammar or spelling
- Avoid copy-pasting AI-generated summaries that don't reflect your own understanding

AI-generated summaries tend to be long-winded, dense, and often inaccurate. Simplicity is an art. The goal is not to sound impressive, but to communicate clearly.

## Never let an LLM think for you

Go ahead and use AI to explore the codebase, or to write the function or test you need. But the final step before contributing should always be understanding what it has written.

- Feel free to use AI tools to generate code or explore ideas
- Only submit contributions you fully understand and can explain
- Contributions should reflect your own reasoning and problem-solving

Use AI to point you in the right direction, but always take personal responsibility. Do not quote an LLM in an issue or pull request. Maintainers want to know what you think.

Our aim is ensuring quality and maintaining the joy of collaborating and communicating with real people.

## Summary

- AI may be used to generate code or explore ideas
- Comments, issues, and pull request descriptions must be written in your own voice
- Contributions must be fully understood and explainable by the contributor
- Contribution guidelines must still be followed

This policy is based on the [Human Voice policy, version 1.0.0](https://ai-policy.dev/policies/human-voice/1.0.0) from 2026-09-23. Read more about this and other AI contribution policies on [ai-policy.dev](https://ai-policy.dev/).
```

Read it as written for me: I am the contributor, and you are the LLM it refers to. It applies to all my work, and especially to open source.

For any text that will be published, the policy means:

1. **Outline it.** Give me short notes on what to cover: what changed and why, the relevant facts, identifiers, and links, and anything the project's template or commit format requires. Don't write finished prose.
2. **I write it.**
3. **Proofread it.** Check facts, identifiers, commands, links, and the project's conventions. Follow the Editing my text rules in Writing: fix mechanical and factual errors directly, and list anything else as a suggestion. Sometimes I may leave comments like "fill in this code sample" or "fill in this link"; complete those too.
4. **Post it** only after I approve the final text (see [Permission](#permission)).

For code, the policy means: before I open a PR, make sure I've reviewed the diff, and walk me through anything I haven't.

## Exceptions

For some work you may write the text yourself, such as Harper repos or specific personal projects. That has to come from a more specific rule (an org rule or a repo's `CLAUDE.md`) or from me for the current task. Without one, Human Voice applies. [Permission](#permission) still applies unless that rule explicitly says otherwise.

## Voice

When you write text for me, under an exception or as a proofreading fix:

- Write in the **first person as me**. Never refer to me in the third person, or as though a separate author wrote it (not "after digging into this with @Ethan-Arrowood").

## Footer

Add a footer to anything you were involved in (outlining, proofreading, drafting, or sending). `<model>` is the human-readable name of the model actually running, for example "Claude Opus N.N" or "GPT-N Codex".

The text depends on who wrote the message. Two links appear in it:

- My setup: `https://github.com/Ethan-Arrowood/agentic` (the tools, rules, and workflow behind the message).
- Human Voice: `https://ai-policy.dev/policies/human-voice/1.0.0`.

Footer text:

- Human Voice (default): `AI-assisted (<model>, my setup). The words are my own, per the Human Voice policy.`
- Under an [exception](#exceptions): `Drafted with <model> (my setup) and reviewed by me.` Don't mention Human Voice, since it didn't apply.

Put it at the end on its own line, in the platform's markup, with "my setup" and "Human Voice" as links:

- Renders HTML (GitHub): `<sub>…</sub>`, for example `<sub>AI-assisted (<model>, [my setup](https://github.com/Ethan-Arrowood/agentic)). The words are my own, per the [Human Voice](https://ai-policy.dev/policies/human-voice/1.0.0) policy.</sub>`
- Markdown without HTML: italics, `_…_`.
- Slack: italics, `_…_`, with Slack's link syntax, such as `<https://github.com/Ethan-Arrowood/agentic|my setup>`.
- Plain text (email and similar): a `---` line, then the footer with each bare URL in parentheses after its link text.

Other cases:

- PR descriptions use this footer instead of the tool's own attribution line (such as "Generated with Claude Code").
- Commit messages use trailers instead of a footer (see the Git rules).
- No footer in release or publish text, such as GitHub Release notes or changelogs.
