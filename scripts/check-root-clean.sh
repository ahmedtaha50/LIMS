#!/usr/bin/env bash
# The repository root holds configuration, not code generators. One-shot patch/fix scripts at the root were how the
# duplicate /audit/verify route and the unattributed edits to regulated code got in (roadmap M02, GX-14).
# Fails when a tracked file at the root is
#   - a script (.cjs, .js, .mjs) other than the tool configuration files below, or
#   - a TypeScript file other than the three entry/config files below, or
#   - a lockfile other than package-lock.json (two lockfiles mean two different dependency trees).
# Files that are still in the index but already deleted from disk are ignored, so the check also works before commit.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
ALLOWED_TS=" server.ts vite.config.ts vitest.config.ts "
# Configuration that its tool reads from the root only (eslint's flat config: r2-ui-foundation's accessibility lint).
ALLOWED_CONFIG=" eslint.config.js "
bad=0
while IFS= read -r -d '' f; do
  case "$f" in */*) continue ;; esac
  [ -e "$f" ] || continue
  case "$f" in
    *.cjs|*.js|*.mjs) case "$ALLOWED_CONFIG" in *" $f "*) ;; *) echo "STRAY SCRIPT   $f"; bad=1 ;; esac ;;
    *.ts) case "$ALLOWED_TS" in *" $f "*) ;; *) echo "STRAY TS FILE  $f"; bad=1 ;; esac ;;
    bun.lock|bun.lockb|yarn.lock|pnpm-lock.yaml) echo "SECOND LOCKFILE $f (package-lock.json is the only lockfile)"; bad=1 ;;
  esac
done < <(git ls-files -z)
if [ "$bad" -ne 0 ]; then
  echo "Root is not clean. Put scripts under scripts/, and do not generate code with one-shot patch scripts."
  exit 1
fi
echo "Root is clean."
