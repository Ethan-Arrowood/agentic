# Writing

Applies to all prose you write: replies to me, docs, code comments, commit messages, PR and issue text, and messages.

## Project conventions first

If the project has a style guide, follow it. Look for a `STYLE.md` or docs style page, writing sections in `CONTRIBUTING.md` or `AGENTS.md`, or a prose linter config (`.vale.ini`, `.textlintrc*`, `.alexrc*`). With no guide, match the voice of the surrounding text: person (`you` or `we`), formality, tense, terminology, and level of detail. New text should read as if the same author wrote the whole file. The rules below are defaults for when nothing else applies.

## Be brief

- Say it once, in the fewest words that keep it correct. Cut any sentence that adds no information.
- Lead with the point. No preamble, no restating the question, no closing summary that repeats the body.
- Prefer short, plain words: "use" not "utilize", "to" not "in order to", "now" not "at this point in time".

## Cut filler

Avoid:
- Intensifiers and softeners: very, really, just, simply, basically, actually, quite, essentially.
- Empty openers: "It's worth noting that", "It's important to", "Note that", "Keep in mind that".
- Marketing words: seamless, robust, powerful, comprehensive, leverage, delve, elevate.
- Stacked hedges like "may potentially" or "could possibly". Hedge once, only where the uncertainty is real, and say what it is ("untested on Linux").

## Sentences

- One idea per sentence. If a sentence chains clauses with "and", "but", or "which", split it. Past about 25 words, split it.
- No em dashes (—) or en dashes (–) as punctuation. Use a period, comma, colon, or parentheses. Hyphens in compound words are fine.
- Use semicolons to join clauses sparingly. Prefer two sentences. An occasional "; <however/moreover/furthermore>," is okay.
- Active voice. Name who or what does the action.
- Be concrete. Name the file, command, value, or number instead of describing it.

## Correctness

- State only what you have checked. Say plainly what is verified and what is assumed.
- Copy identifiers, commands, paths, and versions exactly. Don't paraphrase them.
- Use one term per concept and keep it consistent.
- Make sure links, examples, and numbers are right before you finish.

## Editing my text

Applies whenever you review or edit text I wrote: messages I'm about to post, docs, rules, and comments.

- Fix mechanical errors directly, without asking: spelling, typos, wrong homophones ("its" or "it's"), missing or doubled words, broken Markdown, and a missing newline at the end of a file.
- Fix factual errors in identifiers, commands, paths, versions, and links the same way.
- After editing, list each fix in one line so I can check it.
- Anything that changes wording, meaning, tone, or structure is a suggestion. Give the reason and leave the text as is. The voice is mine.
