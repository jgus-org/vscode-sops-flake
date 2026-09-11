#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! $1 =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Usage: version-stamp MAJOR.MINOR.PATCH (an increasing stable version)' >&2
  exit 1
fi
version=$1

if [[ ! -f package.json || ! -f package-lock.json ]]; then
  echo 'Run version-stamp from the repository root containing package.json and package-lock.json.' >&2
  exit 1
fi
current=$(jq -er '.version' package.json)
if [[ "$version" == "$current" || $(printf '%s\n' "$current" "$version" | sort -V | tail -n 1) != "$version" ]]; then
  printf 'Version %s must be greater than the current version %s.\n' "$version" "$current" >&2
  exit 1
fi
if ! jq -e --arg version "$current" '.version == $version and .packages[""].version == $version' package-lock.json >/dev/null; then
  echo 'package-lock.json must match the current package.json version before stamping.' >&2
  exit 1
fi

npm version "$version" --no-git-tag-version --ignore-scripts
