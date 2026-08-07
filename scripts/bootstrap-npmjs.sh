#!/usr/bin/env bash
#
# One-time bootstrap of the @azerothian packages onto npmjs.
#
# Why this exists: neither `npm stage publish` nor an OIDC trusted publisher can
# create a package name that has never been published, and npm now demands an
# OTP for token-authenticated direct publishing - which CI cannot supply. So the
# very first publish of each new name has to happen here, interactively, with a
# real OTP. Every release after this one goes through CI.
#
# This mirrors .github/workflows/release.yaml exactly: same version bump, same
# internal-range rewrite, same build, same publishConfig strip, same per-package
# direct-vs-staged decision. Run it from a clean tree; the source manifests are
# restored on exit whether it succeeds or fails.
#
# Usage:  ./scripts/bootstrap-npmjs.sh [--dry-run]
#
set -euo pipefail

VERSION="7.0.0-beta.1"
NPM_TAG="beta"
REGISTRY="https://registry.npmjs.org"
# Dependency order, leaves first. Keep in sync with release.yaml.
PACKAGES="graphql-types utilize ormize gqlize ormize-adapter-sequelize ormize-adapter-valkey ormize-zod4 nestize temporalize"

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN="--dry-run"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The bump rewrites tracked manifests, so a dirty tree would make the restore
# below ambiguous - it could clobber real work.
if [ -n "$(git status --porcelain -- packages)" ]; then
  echo "error: packages/ has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

restore() {
  echo
  echo "==> restoring source manifests to their committed state"
  git checkout -- packages/*/package.json 2>/dev/null || true
  git status --porcelain -- packages
}
trap restore EXIT

# `npm stage` landed in npm 11.15.0. A shell that inherited an older PATH would
# sail through the seven direct publishes and only fail on gqlize at the very
# end, so check up front - and try nvm's default before giving up.
NPM_STAGE_FLOOR="11.15.0"
npm_too_old() {
  [ "$(printf '%s\n%s\n' "$NPM_STAGE_FLOOR" "$(npm -v)" | sort -V | head -1)" != "$NPM_STAGE_FLOOR" ]
}
if npm_too_old; then
  echo "npm $(npm -v) is below $NPM_STAGE_FLOOR (no \`npm stage\`); trying nvm's default"
  # shellcheck disable=SC1090
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use default >/dev/null 2>&1 || true
  fi
  if npm_too_old; then
    echo "error: npm $(npm -v) (node $(node -v)) cannot run \`npm stage\`." >&2
    echo "       Need >= $NPM_STAGE_FLOOR. Run \`nvm use default\` and retry." >&2
    exit 1
  fi
  echo "switched to node $(node -v) / npm $(npm -v)"
fi

echo "==> node $(node -v), npm $(npm -v)"
echo "==> npm identity"
npm whoami --registry="$REGISTRY"
echo

echo "==> bumping packages to $VERSION"
node -e '
  const fs = require("fs");
  const version = process.argv[1];
  for (const pkg of fs.readdirSync("packages")) {
    const file = `packages/${pkg}/package.json`;
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = version;
    // Plain-semver @azerothian/* ranges do not travel with the release and would
    // otherwise demand siblings from the previous major. workspace: ranges are
    // left alone - prepare-package.ts resolves those against these manifests.
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = json[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (!name.startsWith("@azerothian/")) continue;
        if (String(deps[name]).startsWith("workspace:")) continue;
        deps[name] = `^${version}`;
        console.log(`  ${json.name} ${field}.${name} -> ^${version}`);
      }
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${json.name} -> ${version}`);
  }
' "$VERSION"
echo

echo "==> building"
pnpm build >/dev/null
echo "build ok"
echo

echo "==> stripping publishConfig.registry from the publish/ artifacts"
# The source manifests keep pointing at GitHub Packages on purpose; publish/ is
# a generated artifact, so stripping here retargets npmjs without touching git.
node -e '
  const fs = require("fs");
  for (const pkg of process.argv.slice(1)) {
    const file = `packages/${pkg}/publish/package.json`;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    if (json.publishConfig) {
      delete json.publishConfig.registry;
      if (Object.keys(json.publishConfig).length === 0) delete json.publishConfig;
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`  stripped ${file}`);
  }
' $PACKAGES
echo

echo "==> sanity check: every artifact is at $VERSION"
for pkg in $PACKAGES; do
  v="$(node -e "console.log(require('./packages/${pkg}/publish/package.json').version)")"
  if [ "$v" != "$VERSION" ]; then
    echo "error: packages/${pkg}/publish is at $v, expected $VERSION" >&2
    exit 1
  fi
done
echo "all 8 artifacts at $VERSION"
echo

if [ -n "$DRY_RUN" ]; then
  echo "==> DRY RUN - validating packaging and auth, publishing nothing"
fi

published=""
staged=""
skipped=""

for pkg in $PACKAGES; do
  name="@azerothian/${pkg}"
  echo "---------------------------------------------------------------"

  if npm view "${name}@${VERSION}" version --registry="$REGISTRY" >/dev/null 2>&1; then
    echo "SKIP    ${name}@${VERSION} is already on npmjs"
    skipped="${skipped} ${name}"
    continue
  fi

  if npm view "$name" version --registry="$REGISTRY" >/dev/null 2>&1; then
    # The name exists, so it can go through the approval gate.
    echo "STAGE   ${name}@${VERSION} (tag: ${NPM_TAG})"
    ( cd "packages/${pkg}/publish" \
      && npm stage publish --registry="$REGISTRY" --access public --tag "$NPM_TAG" $DRY_RUN )
    staged="${staged} ${name}"
  else
    # First ever publish of this name - the reason this script exists.
    echo "PUBLISH ${name}@${VERSION} (tag: ${NPM_TAG})  <- will prompt for your OTP"
    ( cd "packages/${pkg}/publish" \
      && npm publish --registry="$REGISTRY" --access public --tag "$NPM_TAG" $DRY_RUN )
    published="${published} ${name}"
  fi
done

echo "==============================================================="
echo "bootstrap complete${DRY_RUN:+ (DRY RUN - nothing was published)}"
[ -n "$published" ] && { echo; echo "published directly:"; for n in $published; do echo "  $n"; done; }
[ -n "$staged" ]    && { echo; echo "staged, awaiting approval:"; for n in $staged; do echo "  $n"; done;
                         echo; echo "  npm stage list"; echo "  npm stage approve <stage-id>"; }
[ -n "$skipped" ]   && { echo; echo "already present, skipped:"; for n in $skipped; do echo "  $n"; done; }
echo
echo "Next: configure a trusted publisher for each newly published package -"
echo "  Organization/user:   Azerothian"
echo "  Repository:          gqlize"
echo "  Workflow filename:   release.yaml"
echo "  Environment:         production"
echo "  Allowed actions:     npm stage publish   (only)"
