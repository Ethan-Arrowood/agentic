#!/bin/zsh
# Print a PR's discussion (reviews, PR comments, and inline review threads)
# without hidden or blocked-user content.
# Usage: discussion.sh <pr>
#
# Reads through GraphQL, because only GraphQL exposes isMinimized and
# minimizedReason. `gh pr view --json reviews,comments` and the REST endpoints
# omit them, so a review hidden as spam or low-quality looks legitimate there.
#
# Dropped entirely (body never printed): minimizedReason spam, abuse,
# low-quality, or off-topic, and anything by a user the nodejs org has
# blocked. Marked [resolved] but kept: outdated, duplicate, or resolved
# content, and resolved inline threads. A summary line lists what was dropped.
#
# The block check needs org moderation rights (204 = blocked, 404 = not).
# Without them it errors, and the script skips it. BLOCKS=0 turns it off.
# Fetches the first 100 of each list, which covers nearly every PR. A
# warning prints when a list has more.
source "${0:A:h}/lib.sh"
n=${1:?usage: discussion.sh <pr>}

q='query($n:Int!){repository(owner:"nodejs",name:"node"){pullRequest(number:$n){
  reviews(first:100){totalCount nodes{author{login} authorAssociation state submittedAt isMinimized minimizedReason body}}
  comments(first:100){totalCount nodes{author{login} authorAssociation createdAt isMinimized minimizedReason body}}
  reviewThreads(first:100){totalCount nodes{isResolved isOutdated path line
    comments(first:50){nodes{author{login} createdAt isMinimized minimizedReason body}}}}}}}'
json=$(gh_retry gh api graphql -F n="$n" -f query="$q") || { echo "discussion.sh: GraphQL query failed" >&2; exit 1; }
pr='.data.repository.pullRequest'

for list in reviews comments reviewThreads; do
  total=$(print -r -- "$json" | jq "$pr.$list.totalCount")
  (( total > 100 )) && echo "warning: $list has $total entries; only the first 100 are shown" >&2
done

# Logins to drop because the org blocked them. Bots and members are skipped.
blocked=()
if [[ ${BLOCKS:-1} = 1 ]]; then
  for u in $(print -r -- "$json" | jq -r "[$pr.reviews.nodes[], $pr.comments.nodes[]
      | select(.authorAssociation | IN(\"NONE\",\"FIRST_TIMER\",\"FIRST_TIME_CONTRIBUTOR\",\"CONTRIBUTOR\"))
      | .author.login] + [$pr.reviewThreads.nodes[].comments.nodes[].author.login] | unique[]"); do
    code=$(gh api -i "orgs/nodejs/blocks/$u" 2>/dev/null | head -1 | awk '{print $2}')
    case $code in
      204) blocked+=$u ;;
      404|'') ;;
      *) echo "note: org block check unavailable (HTTP $code); skipping it" >&2; break ;;
    esac
    sleep 1
  done
fi
blocked_json=$(printf '%s\n' "${blocked[@]}" | jq -R . | jq -sc 'map(select(. != ""))')

print -r -- "$json" | jq -r --argjson blocked "$blocked_json" "
  def hidden: (.isMinimized and (.minimizedReason | ascii_downcase | IN(\"spam\",\"abuse\",\"low-quality\",\"low_quality\",\"off-topic\",\"off_topic\")))
              or ((.author.login // \"ghost\") as \$a | \$blocked | index(\$a));
  def tag: if .isMinimized then \" [resolved: \(.minimizedReason)]\" else \"\" end;
  def who: \"\(.author.login // \"ghost\")\";
  $pr as \$p
  | ([\$p.reviews.nodes[], \$p.comments.nodes[], \$p.reviewThreads.nodes[].comments.nodes[]] | map(select(hidden))) as \$dropped
  | \"== reviews ==\",
    (\$p.reviews.nodes[] | select(hidden | not) | \"--- \(who) (\(.authorAssociation)) \(.state) @ \(.submittedAt[:10])\(tag)\n\(.body)\"),
    \"== PR comments ==\",
    (\$p.comments.nodes[] | select(hidden | not) | \"--- \(who) (\(.authorAssociation)) @ \(.createdAt[:10])\(tag)\n\(.body)\"),
    \"== inline threads ==\",
    (\$p.reviewThreads.nodes[]
      | (if .isResolved then \" [resolved thread]\" elif .isOutdated then \" [outdated]\" else \"\" end) as \$st
      | \"### \(.path):\(.line // \"?\")\(\$st)\",
        (.comments.nodes[] | select(hidden | not) | \"--- \(who) @ \(.createdAt[:10])\(tag)\n\(.body)\")),
    \"== dropped: \(\$dropped | length) hidden or blocked item(s)\" +
      (if (\$dropped | length) > 0 then \": \" + (\$dropped | map(\"\(who) (\(.minimizedReason // \"org-blocked\"))\") | unique | join(\", \")) else \"\" end)
"
