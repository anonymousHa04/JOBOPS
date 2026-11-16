#!/bin/sh
# Apply a validated patch to a tree and prove the tree now holds exactly that
# patch: it must apply cleanly, and its reverse must then apply cleanly too.
# Usage: apply-patch.sh <tree> <patch-file>
# Exit 0 = applied and verified; 1 = not applied (tree unchanged) or mismatch.
set -u
tree=$1; patch=$2
if [ ! -s "$patch" ]; then echo "APPLY: empty or missing patch $patch"; exit 1; fi
if ! git -C "$tree" apply --check "$patch" 2>&1; then
  echo "APPLY: patch does not apply cleanly; tree unchanged"; exit 1
fi
git -C "$tree" apply "$patch" || { echo "APPLY: git apply failed"; exit 1; }
if ! git -C "$tree" apply --reverse --check "$patch" >/dev/null 2>&1; then
  echo "APPLY: tree does not match the validated patch after applying"; exit 1
fi
echo "APPLY: ok"
