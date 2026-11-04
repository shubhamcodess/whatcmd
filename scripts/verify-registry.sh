#!/usr/bin/env bash
# Proves that what is on the npm registry installs and runs.
#   scripts/verify-registry.sh <package-name> <version> [tries]
# Waits for the version to appear (10 s per try, default 30 tries), installs it into an empty prefix and runs the CLI.
# VERIFY_PROVENANCE=1 also requires a provenance attestation.
set -euo pipefail
NAME="${1:?usage: verify-registry.sh <name> <version> [tries]}"
VERSION="${2:?usage: verify-registry.sh <name> <version> [tries]}"
TRIES="${3:-30}"

for i in $(seq 1 "$TRIES"); do
  if [ "$(npm view "$NAME@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; then break; fi
  [ "$i" = "$TRIES" ] && { echo "FAIL $NAME@$VERSION did not appear on the registry"; exit 1; }
  sleep 10
done
echo "ok   $NAME@$VERSION is on the registry"

if [ "${VERIFY_PROVENANCE:-0}" = "1" ]; then
  ATT="$(npm view "$NAME@$VERSION" --json dist.attestations 2>/dev/null || true)"
  [ -n "$ATT" ] && [ "$ATT" != "undefined" ] || { echo "FAIL no provenance attestation on $NAME@$VERSION"; exit 1; }
  echo "ok   provenance attestation present"
fi

P="$(mktemp -d)"
npm install -g --prefix "$P" "$NAME@$VERSION" >/dev/null
[ "$("$P/bin/whatcmd" --version)" = "$VERSION" ] || { echo "FAIL whatcmd --version is not $VERSION"; exit 1; }
echo "ok   whatcmd --version"
"$P/bin/whatcmd" shell zsh | grep -q "whatcmd shell hook" || { echo "FAIL shell hook not printed"; exit 1; }
echo "ok   shell hook prints"
"$P/bin/whatcmd" --help | grep -q "whatcmd" || { echo "FAIL help"; exit 1; }
echo "ok   help prints"
