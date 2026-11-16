#!/bin/sh
# Write a compact map of every export in api/src (one line per export) to
# .agent-logs/api-map.md, so a local coder with an 8k context knows the real
# names, paths, and signatures it can import. Regenerated before every task.
set -u
root=$(git rev-parse --show-toplevel)
out="$root/.agent-logs/api-map.md"
mkdir -p "$root/.agent-logs"
{
  echo "# API map: exports in api/src (generated; import paths are relative to api/src)"
  find "$root/api/src" -name '*.ts' | sort | while read -r f; do
    lines=$(grep -E '^export (async )?(function|const|type|class|interface) ' "$f" \
      | sed -E 's/^(export const [A-Za-z0-9_]+) = (async )?(\([^)]*\))(: [^=]+)? =>.*/\1\3\4/; s/ \{$//; s/ =$//; s/(export (const|type) [A-Za-z0-9_]+) =.*/\1/' | cut -c1-160)
    [ -z "$lines" ] && continue
    echo
    echo "## ${f#"$root/api/src/"}"
    printf '%s\n' "$lines"
  done
} > "$out"
echo "$out"
