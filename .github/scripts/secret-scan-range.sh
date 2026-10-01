#!/usr/bin/env bash
# The range `secret-scan.yml` hands gitleaks, resolved from the event's SHAs (#538).
#
# Prints `BASE..HEAD` on stdout — nothing else — and exits 0; exits 2 with a `::error::` on stderr
# when there is no range to scan — the workflow treats that as a failed gate, never a pass.
# `::notice::` lines go to stderr too.
#
# Inputs (environment): BASE_SHA, HEAD_SHA, REF_NAME (the pushed branch), DEFAULT_BRANCH.
#
# `BASE_SHA` is not always a base you can diff from: it is forty zeroes when the branch was just
# created, and an unreachable object after a force-push that dropped it. Either way the scan must
# still cover what was pushed rather than pass with nothing to read — this gate's failure is the
# irreversible one. The fallback, in order:
#   1. On a branch other than the default: everything since the branch left it — the merge-base
#      with `origin/<default>`. A new branch's first push carries ALL its commits, not just the
#      tip, and so must the scan. ⚠ A branch that forked long ago and is pushed for the first
#      time walks everything since the fork: over-scanning, never under-scanning, inside the
#      job's timeout.
#   2. The commit's first parent: on the default branch itself, or when no merge-base exists.
#   3. Neither: no range, exit 2.
#
# ⚠ `test/secret-scan-gate.test.ts` runs THIS FILE against fixture repositories; the workflow
# calls it with the event's values. One resolver, both places.
set -uo pipefail

if [ -z "${BASE_SHA:-}" ] || [ -z "${HEAD_SHA:-}" ]; then
  echo "::error::No base/head SHAs in context — refusing to pass a required gate without a range to scan." >&2
  exit 2
fi

if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  fallback=''
  if [ "${REF_NAME:-}" != "${DEFAULT_BRANCH:-}" ]; then
    fallback=$(git merge-base "origin/${DEFAULT_BRANCH:-}" "${HEAD_SHA}" 2>/dev/null) || fallback=''
  fi
  if [ -z "${fallback}" ]; then
    fallback=$(git rev-parse --verify --quiet "${HEAD_SHA}^") || fallback=''
  fi
  if [ -z "${fallback}" ]; then
    echo "::error::${HEAD_SHA} has no parent and ${BASE_SHA} is not in this checkout — no range to scan." >&2
    exit 2
  fi
  echo "::notice::Base ${BASE_SHA} is unusable (new branch or force-push); scanning ${fallback}..${HEAD_SHA} instead." >&2
  BASE_SHA="${fallback}"
fi

echo "${BASE_SHA}..${HEAD_SHA}"
