// The automation screen. Node's AI policy (doc/contributing/ai-guidelines.md)
// allows AI help, but automated tooling must not open pull requests without
// approval, and a contributor who used AI should disclose it. Collaborators are
// trusted and skip the screen. For everyone else, the agentscan label and the
// bot's AgentScan caution are heuristics that trigger the check. Detection is
// deliberately simple: anything short of a clear pass is unclear, and the user
// decides.
import fs from "node:fs";
import path from "node:path";
import { CACHE, REPO, SCREEN_HOURS } from "./config.ts";
import { type Entry } from "./entry.ts";
import { CommandError, HOUR, clip, git, lines, readText, squash, writeJson } from "./util.ts";

// The PR as `gh pr view --json` returns it, for the fields the bank reads.
export type PrInfo = {
  number: number;
  title: string;
  body: string | null;
  author: { login: string } | null;
  baseRefName?: string;
  headRefOid: string;
  labels?: { name: string }[];
  files?: { path: string }[];
  commits?: { messageBody?: string | null }[];
  updatedAt?: string;
  isDraft?: boolean;
  state?: string;
};

// discussion.sh --json, for the fields the screen reads.
type DiscussionItem = { author?: string | null; association?: string | null; body?: string | null };
export type Discussion = { comments?: DiscussionItem[]; reviews?: DiscussionItem[]; [key: string]: unknown };

type Signals = {
  agentscan_labels: string[];
  agentscan_caution: boolean;
  first_contribution: boolean;
  author_association: string | null;
  ai_trailers: string[];
  disclosure: string | null;
};

// result is pass, unclear, or fail. screen.json in the dossier.
export type Screen = { result: string; why: string; signals: Signals | null };

// \b in JS is ASCII-only, even with the u flag. These count any letter or
// digit as part of a word.
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const AI_WORDS = `(?:${WORD_START}AI${WORD_END}|${WORD_START}LLMs?${WORD_END}|claude|copilot|codex|chatgpt|` +
  `${WORD_START}GPT|gemini|cursor|coding agents?|language models?|agentic)`;
const AI_TRAILER = new RegExp(`^(?:assisted-by|generated-by|(?:co-authored-by|made-with):.*${AI_WORDS}).*$`, "gimu");
const DISCLOSURE = new RegExp(
  `AI[- ]disclosure|AI[- ]assist|${AI_WORDS}[- ](?:assisted|generated|written|helped)|` +
  `(?:used|using|with the help of|generated (?:with|by)|written (?:with|by)|assisted by)\\s+(?:an?\\s+|the\\s+)?${AI_WORDS}|` +
  `${AI_WORDS}\\s+(?:was|were)\\s+used`, "iu");
const MODERATION = "https://github.com/nodejs/admin/blob/main/Moderation-Policy.md";
const AI_POLICY = "https://github.com/nodejs/node/blob/HEAD/doc/contributing/ai-guidelines.md";
// README.md sections whose members are collaborators. Emeriti and triagers aren't.
const COLLABORATOR_SECTIONS = ["#### TSC voting members", "#### TSC regular members", "### Collaborators"];
const COLLABORATORS_HOURS = 24;

// Logins (lowercase) of current collaborators, from README.md on
// upstream/main, cached for a day. Empty if the README can't be read, so
// the screen then applies to everyone.
function collaborators(): Set<string> {
  const p = path.join(CACHE, "collaborators.json");
  try {
    if (Date.now() - fs.statSync(p).mtimeMs < COLLABORATORS_HOURS * HOUR) return new Set(JSON.parse(readText(p)));
  } catch {
    // Missing or unreadable: read the README again.
  }
  let readme: string;
  try {
    readme = git(["show", "upstream/main:README.md"]);
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    return new Set();
  }
  const logins = new Set<string>();
  let inSection = false;
  for (const line of lines(readme)) {
    if (line.startsWith("#")) {
      inSection = COLLABORATOR_SECTIONS.includes(line.trim());
      continue;
    }
    const m = inSection ? /^\* \[([^\]]+)\]/.exec(line) : null;
    if (m) logins.add(m[1].toLowerCase());
  }
  if (logins.size) writeJson(p, [...logins].sort());
  return logins;
}

// The text around a match: 30 characters before, 50 after, whitespace
// squashed, at most `width` characters.
function snippet(m: RegExpExecArray | null, text: string, width = 100): string | null {
  if (!m) return null;
  const around = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 50);
  return clip(squash(around), width);
}

// Screen a PR before any review work.
export function screen(info: PrInfo, disc: Discussion): Screen {
  const body = info.body || "";
  const author = info.author?.login ?? null;
  if (author && collaborators().has(author.toLowerCase())) return { result: "pass", why: "skipped: collaborator", signals: null };
  const flagged = (info.labels ?? []).map((l) => l.name).filter((l) => l.startsWith("agentscan:"));
  const comments = disc.comments ?? [];
  const bot = comments.filter((c) => (c.author || "").startsWith("github-actions"));
  const caution = bot.some((c) => (c.body || "").includes("AgentScan"));
  const first = bot.some((c) => (c.body || "").includes("first contribution"));
  const hit = [...comments, ...(disc.reviews ?? [])].find((c) => (c.author ?? null) === author);
  const messages = (info.commits ?? []).map((c) => c.messageBody || "").join("\n");
  const trailers = [...new Set([...messages.matchAll(AI_TRAILER)].map((t) => squash(t[0])))].sort();
  const told = snippet(DISCLOSURE.exec(body), body);
  const disclosed = Boolean(trailers.length || told);
  const signals: Signals = {
    agentscan_labels: flagged, agentscan_caution: caution, first_contribution: first,
    author_association: hit?.association ?? null, ai_trailers: trailers, disclosure: told,
  };
  if (!(flagged.length || caution)) {
    return { result: "pass", why: `not flagged by AgentScan${disclosed ? "; AI use disclosed" : ""}`, signals };
  }
  if (!disclosed) return { result: "fail", why: "flagged by AgentScan, with no AI disclosure", signals };
  // Flagged and disclosed: the flag suggests automated opening, which the
  // policy forbids without approval, so a disclosure alone doesn't settle it.
  return { result: "unclear", why: "flagged by AgentScan; AI use disclosed", signals };
}

// The signals on one line, for list, plan, and the entry's screen field.
export function screenLine(sc: Screen): string {
  const s = sc.signals;
  if (!s) return `${sc.result}: ${sc.why}`;
  const parts = [...s.agentscan_labels];
  if (s.agentscan_caution) parts.push("AgentScan caution");
  if (s.first_contribution) parts.push("first contribution");
  parts.push(s.disclosure || s.ai_trailers.length ? "disclosed" : "no disclosure");
  return `${sc.result}: ${parts.join(", ")}`;
}

// A screen entry's body: the signals, the policy, and an outline for the
// user's comment. An outline, not a comment: the user writes it.
export function screenBody(pr: string, info: PrInfo, sc: Screen): string {
  const s = sc.signals!, author = info.author?.login || "ghost";
  const found = (v: string | null) => (v ? `found: "${v}"` : "none found");
  const missing = s.disclosure || s.ai_trailers.length
    ? "confirmation that a person, not automated tooling, opened the PR and will handle review."
    : "the AI disclosure, and confirmation that a person opened the PR and will handle review.";
  return [
    `## [#${pr}](https://github.com/${REPO}/pull/${pr}) ${info.title} (automation screen)`, "",
    "### Screen", "",
    `Result: **${sc.result}**, ${sc.why}. No review was prepared.`, "",
    `- Author: @${author}, association ${s.author_association || "unknown (no comment by them)"}` +
    (s.first_contribution ? ", first contribution (github-actions welcome comment)" : ""),
    `- AgentScan: label ${s.agentscan_labels.join(", ") || "none"}; caution in the github-actions ` +
    `comment: ${s.agentscan_caution ? "yes" : "no"}`,
    `- AI disclosure in the PR body: ${found(s.disclosure)}`,
    `- AI trailers in the commits: ${s.ai_trailers.join(", ") || "none"}`, "",
    "Read the PR body and commits yourself before deciding: the screen is pattern matching.", "",
    "### Policy", "",
    `[AI use policy](${AI_POLICY}):`, "",
    "- Pull requests must not be opened by automated tooling without approval in advance.",
    "- A contributor who used AI should disclose it, and must understand, test, and verify what they submit.",
    "- AI-generated pull requests the contributor hasn't understood, tested, and verified are subject " +
    "to closure without further review.",
    `- Messages generated entirely by AI may be removed under the [moderation policy](${MODERATION}).`, "",
    "### Outline for your comment", "",
    "- Point to the github-actions welcome comment (the AgentScan caution) and the AI use policy.",
    "- Ask them to confirm they follow the contribution policies.",
    `- Name what's missing: ${missing}`,
    "- Say you'll review once they respond.", "",
    "### Next", "",
    `After you comment, \`sync\` holds it for ${SCREEN_HOURS} hours. A comment or push by @${author} wakes it ` +
    "for a real review. With no response, it comes back with a recommendation to close it per the " +
    "moderation policy.",
  ].join("\n") + "\n";
}

// A screen entry whose author didn't respond in time.
export function closeBody(e: Entry): string {
  return [
    `## [#${e.pr}](${e.url}) ${e.title} (automation screen: no response)`, "",
    "### Screen", "",
    `No comment or push by @${e.author} in ${SCREEN_HOURS} hours since ${e.wait_since}. ` +
    `Screen at prefetch: ${e.screen || "-"}.`, "",
    `Recommend closing it per the [AI use policy](${AI_POLICY}) (AI-generated pull requests that weren't ` +
    'verified "will be subject to closure without additional review") and the ' +
    `[moderation policy](${MODERATION}).`, "",
    "### Outline for your closing comment", "",
    "- Refer to your earlier comment and that there was no response.",
    "- Say they can reopen it, or open a new PR, once they can follow the contribution policies.", "",
  ].join("\n");
}
