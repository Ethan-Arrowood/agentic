import { CACHE, REPO, SCREEN_HOURS } from "./config.ts";
import { B, BOL, DOT, EOL, P, RuntimeError, WS, cut, dumps, isOSError, isValueError, mtime, pget, py, sorted, splitWs, splitlines, strip } from "./py.ts";
import { git, readText, writeAtomic } from "./util.ts";

import { type Entry } from "./entry.ts";

// The automation screen. Node's AI policy (doc/contributing/ai-guidelines.md)
// allows AI help, but automated tooling must not open pull requests without
// approval, and a contributor who used AI should disclose it. Collaborators are
// trusted and skip the screen. For everyone else, the agentscan label and the
// bot's AgentScan caution are heuristics that trigger the check. Detection is
// deliberately simple: anything short of a clear pass is unclear, and the user
// decides.
export const AI_WORDS = `(?:${B}AI${B}|${B}LLMs?${B}|claude|copilot|codex|chatgpt|${B}GPT|gemini|cursor|` +
  "coding agents?|language models?|agentic)";
export const AI_TRAILER = new RegExp(`${BOL}(?:assisted-by|generated-by|(?:co-authored-by|made-with):${DOT}*${AI_WORDS})${DOT}*${EOL}`, "giu");
export const DISCLOSURE = new RegExp(
  `AI[- ]disclosure|AI[- ]assist|${AI_WORDS}[- ](?:assisted|generated|written|helped)|` +
  `(?:used|using|with the help of|generated (?:with|by)|written (?:with|by)|assisted by)[${WS}]+(?:an?[${WS}]+|the[${WS}]+)?${AI_WORDS}|` +
  `${AI_WORDS}[${WS}]+(?:was|were)[${WS}]+used`, "iu");
export const MODERATION = "https://github.com/nodejs/admin/blob/main/Moderation-Policy.md";
export const AI_POLICY = "https://github.com/nodejs/node/blob/HEAD/doc/contributing/ai-guidelines.md";
// README.md sections whose members are collaborators. Emeriti and triagers aren't.
export const COLLABORATOR_SECTIONS = ["#### TSC voting members", "#### TSC regular members", "### Collaborators"];
export const COLLABORATORS_HOURS = 24;

// Logins (lowercase) of current collaborators, from README.md on
// upstream/main, cached for a day. Empty if the README can't be read, so
// the screen then applies to everyone.
export function collaborators(): Set<string> {
  const p = P(CACHE, "collaborators.json");
  try {
    if (Date.now() / 1000 - mtime(p) < COLLABORATORS_HOURS * 3600) return new Set(JSON.parse(readText(p)));
  } catch (err) {
    if (!(isOSError(err) || isValueError(err))) throw err;
  }
  let readme: string;
  try {
    readme = git(["show", "upstream/main:README.md"]);
  } catch (err) {
    if (!(err instanceof RuntimeError)) throw err;
    return new Set();
  }
  const logins = new Set<string>();
  let section: boolean | null = null;
  for (const line of splitlines(readme)) {
    if (line.startsWith("#")) {
      section = COLLABORATOR_SECTIONS.includes(strip(line));
      continue;
    }
    const m = section && /^\* \[([^\]]+)\]/.exec(line);
    if (m) logins.add(m[1].toLowerCase());
  }
  if (logins.size) writeAtomic(p, dumps(sorted(logins)));
  return logins;
}

export function snippet(m: RegExpExecArray | null, text: string, width = 100): string | null {
  if (!m) return null;
  // Python counts code points.
  const cps = Array.from(text), start = Array.from(text.slice(0, m.index)).length, end = start + Array.from(m[0]).length;
  const [a, b] = [Math.max(0, start - 30), Math.min(cps.length, end + 50)];
  return cut(splitWs(cps.slice(a, b).join("")).join(" "), 0, width);
}

export type Signals = {
  agentscan_labels: string[]; agentscan_caution: boolean; first_contribution: boolean;
  author_association: string | null; ai_trailers: string[]; disclosure: string | null;
};
export type Screen = { result: string; why: string; signals: Signals | null };

// Screen a PR before any review work. Returns: result (pass, unclear, or
// fail), why, and the signals found.
export function screen(info: any, disc: any): Screen {
  const body: string = info.body || "";
  const author = pget(info.author || {}, "login");
  if (author && collaborators().has(author.toLowerCase())) return { result: "pass", why: "skipped: collaborator", signals: null };
  const labels: string[] = (info.labels || []).map((l: any) => l.name);
  const flagged = labels.filter((l) => l.startsWith("agentscan:"));
  const comments: any[] = disc.comments || [];
  const bot = comments.filter((c) => (c.author || "").startsWith("github-actions"));
  const caution = bot.some((c) => (c.body || "").includes("AgentScan"));
  const first = bot.some((c) => (c.body || "").includes("first contribution"));
  const hit = [...comments, ...(disc.reviews || [])].find((c) => pget(c, "author") === author);
  const assoc = hit ? pget(hit, "association") : null;
  const messages = (info.commits || []).map((c: any) => c.messageBody || "").join("\n");
  const trailers = sorted(new Set([...messages.matchAll(AI_TRAILER)].map((t) => splitWs(t[0]).join(" "))));
  const told = snippet(DISCLOSURE.exec(body), body);
  const disclosed = Boolean(trailers.length || told);
  const sig: Signals = {
    agentscan_labels: flagged, agentscan_caution: caution, first_contribution: first,
    author_association: assoc, ai_trailers: trailers, disclosure: told,
  };
  if (!(flagged.length || caution)) {
    const why = "not flagged by AgentScan" + (disclosed ? "; AI use disclosed" : "");
    return { result: "pass", why, signals: sig };
  }
  if (!disclosed) return { result: "fail", why: "flagged by AgentScan, with no AI disclosure", signals: sig };
  // Flagged and disclosed: the flag suggests automated opening, which the
  // policy forbids without approval, so a disclosure alone doesn't settle it.
  return { result: "unclear", why: "flagged by AgentScan; AI use disclosed", signals: sig };
}

// The signals on one line, for list, plan, and the entry's screen field.
export function screenLine(sc: Screen): string {
  const s = sc.signals;
  if (!s) return `${sc.result}: ${sc.why}`;
  const parts = [...s.agentscan_labels];
  if (s.agentscan_caution) parts.push("AgentScan caution");
  if (s.first_contribution) parts.push("first contribution");
  parts.push(s.disclosure || s.ai_trailers.length ? "disclosed" : "no disclosure");
  return `${sc.result}: ` + parts.join(", ");
}

// A screen entry's body: the signals, the policy, and an outline for the
// user's comment. An outline, not a comment: the user writes it.
export function screenBody(n: string, info: any, sc: Screen): string {
  const s = sc.signals!, author = pget(info.author || {}, "login") || "ghost";
  const found = (v: string | null) => (v ? `found: "${v}"` : "none found");
  const lines = [`## [#${n}](https://github.com/${REPO}/pull/${n}) ${py(info.title)} (automation screen)`, "",
    "### Screen", "",
    `Result: **${sc.result}**, ${sc.why}. No review was prepared.`, "",
    `- Author: @${author}, association ${s.author_association || "unknown (no comment by them)"}`
    + (s.first_contribution ? ", first contribution (github-actions welcome comment)" : ""),
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
    "- Name what's missing: " + (!(s.disclosure || s.ai_trailers.length) ? "the AI disclosure, and confirmation that a person opened the PR and " +
    "will handle review." :
      "confirmation that a person, not automated tooling, opened the PR and will handle review."),
    "- Say you'll review once they respond.", "",
    "### Next", "",
    `After you comment, \`sync\` holds it for ${SCREEN_HOURS} hours. A comment or push by @${author} wakes it ` +
    "for a real review. With no response, it comes back with a recommendation to close it per the " +
    "moderation policy."];
  return lines.join("\n") + "\n";
}

// A screen entry whose author didn't respond in time.
export function closeBody(e: Entry): string {
  return [
    `## [#${e.pr}](${e.url}) ${e.title} (automation screen: no response)`, "",
    "### Screen", "",
    `No comment or push by @${py(pget(e, "author", "the author"))} in ${SCREEN_HOURS} hours since ` +
    `${py(pget(e, "wait_since"))}. Screen at prefetch: ${pget(e, "screen") || "-"}.`, "",
    `Recommend closing it per the [AI use policy](${AI_POLICY}) (AI-generated pull requests that weren't ` +
    'verified "will be subject to closure without additional review") and the ' +
    `[moderation policy](${MODERATION}).`, "",
    "### Outline for your closing comment", "",
    "- Refer to your earlier comment and that there was no response.",
    "- Say they can reopen it, or open a new PR, once they can follow the contribution policies.", ""].join("\n");
}
