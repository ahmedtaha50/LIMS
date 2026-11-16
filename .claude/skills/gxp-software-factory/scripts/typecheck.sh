#!/usr/bin/env bash
# Strict TypeScript check of the plain-JavaScript tools (JSDoc types; the tools themselves need nothing but Node).
# Installs a pinned TypeScript and Node types once into a cache folder outside the skill; set FACTORY_TS_CACHE to move it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cache="${FACTORY_TS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/gxp-software-factory-ts}"
if [ ! -x "$cache/node_modules/.bin/tsc" ]; then
  mkdir -p "$cache"
  (cd "$cache" && npm install --silent --no-audit --no-fund typescript@5.6.3 @types/node@22.10.2 >/dev/null)
fi
"$cache/node_modules/.bin/tsc" -p "$here/tsconfig.json" --typeRoots "$cache/node_modules/@types"
echo "typecheck OK (strict): $(cd "$here" && ls lib/*.cjs tests/*.cjs | tr '\n' ' ')"
"$cache/node_modules/.bin/tsc" -p "$here/tsconfig.tools.json" --typeRoots "$cache/node_modules/@types"
echo "typecheck OK (tools): $(cd "$here" && ls *.cjs | wc -l) files"
