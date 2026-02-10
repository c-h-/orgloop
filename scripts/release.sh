#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OrgLoop Release Script
# ============================================================================
#
# Bumps version across all workspace packages, runs pre-flight checks,
# publishes to npm in dependency order, and creates a git tag.
#
# Usage:
#   scripts/release.sh [--patch|--minor|--major|--version X.Y.Z] [--dry-run]
#
# Examples:
#   scripts/release.sh --patch              # 0.1.0 -> 0.1.1
#   scripts/release.sh --minor              # 0.1.0 -> 0.2.0
#   scripts/release.sh --major              # 0.1.0 -> 1.0.0
#   scripts/release.sh --version 1.0.0-rc.1 # explicit version
#   scripts/release.sh --patch --dry-run    # full run without publish/push
#
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- Colors and formatting -------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()     { echo -e "${RED}[error]${NC} $*"; }
step()    { echo -e "\n${BOLD}${CYAN}==> $*${NC}"; }
divider() { echo -e "${DIM}────────────────────────────────────────────────────────────${NC}"; }

# --- Parse arguments --------------------------------------------------------

BUMP=""
DRY_RUN=false
EXPLICIT_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch)   BUMP="patch"; shift ;;
    --minor)   BUMP="minor"; shift ;;
    --major)   BUMP="major"; shift ;;
    --version)
      shift
      EXPLICIT_VERSION="${1:-}"
      if [[ -z "$EXPLICIT_VERSION" ]]; then
        err "--version requires a version argument (e.g., --version 1.0.0)"
        exit 1
      fi
      shift
      ;;
    --dry-run) DRY_RUN=true; shift ;;
    --) shift ;;
    -h|--help)
      echo "Usage: scripts/release.sh [--patch|--minor|--major|--version X.Y.Z] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --patch        Bump patch version (0.1.0 -> 0.1.1)"
      echo "  --minor        Bump minor version (0.1.0 -> 0.2.0)"
      echo "  --major        Bump major version (0.1.0 -> 1.0.0)"
      echo "  --version X    Set explicit version"
      echo "  --dry-run      Do everything except actual npm publish and git push"
      echo "  -h, --help     Show this help"
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      echo "Usage: scripts/release.sh [--patch|--minor|--major|--version X.Y.Z] [--dry-run]"
      exit 1
      ;;
  esac
done

if [[ -z "$BUMP" && -z "$EXPLICIT_VERSION" ]]; then
  err "Must specify one of: --patch, --minor, --major, or --version X.Y.Z"
  echo "Usage: scripts/release.sh [--patch|--minor|--major|--version X.Y.Z] [--dry-run]"
  exit 1
fi

if $DRY_RUN; then
  echo ""
  echo -e "${YELLOW}${BOLD}  DRY RUN MODE — no packages will be published, no git push${NC}"
  echo ""
fi

# --- Publish order (dependency chain) --------------------------------------
# sdk first (no internal deps), then core (depends on sdk),
# then all plugins (depend on sdk), then cli/server (depend on core+plugins),
# then modules (no code deps, logically last).

PUBLISH_ORDER=(
  "packages/sdk"
  "packages/core"
  "connectors/github"
  "connectors/linear"
  "connectors/claude-code"
  "connectors/openclaw"
  "connectors/webhook"
  "connectors/cron"
  "transforms/filter"
  "transforms/dedup"
  "transforms/enrich"
  "loggers/console"
  "loggers/file"
  "loggers/otel"
  "loggers/syslog"
  "packages/cli"
  "packages/server"
  "modules/engineering"
  "modules/minimal"
)

# ============================================================================
# STEP 1: Pre-flight checks
# ============================================================================

step "Pre-flight checks"

# 1a. Git clean check
if [[ -n "$(git status --porcelain)" ]]; then
  err "Working directory is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi
ok "Working directory clean"

# 1b. Branch check
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
info "Current branch: ${BOLD}${CURRENT_BRANCH}${NC}"

# 1c. Node and pnpm check
NODE_VERSION="$(node --version)"
PNPM_VERSION="$(pnpm --version)"
ok "Node ${NODE_VERSION}, pnpm ${PNPM_VERSION}"

# 1d. npm auth check
if npm whoami &>/dev/null; then
  NPM_USER="$(npm whoami)"
  ok "Logged into npm as ${BOLD}${NPM_USER}${NC}"
else
  err "Not logged into npm. Run 'npm login' first."
  exit 1
fi

# ============================================================================
# STEP 2: Compute new version
# ============================================================================

step "Version computation"

CURRENT_VERSION=$(node -p "require('./packages/sdk/package.json').version")

if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="$EXPLICIT_VERSION"
  info "Explicit version: ${CURRENT_VERSION} -> ${NEW_VERSION}"
else
  IFS='.' read -r V_MAJOR V_MINOR V_PATCH <<< "$CURRENT_VERSION"

  case "$BUMP" in
    major) V_MAJOR=$((V_MAJOR + 1)); V_MINOR=0; V_PATCH=0 ;;
    minor) V_MINOR=$((V_MINOR + 1)); V_PATCH=0 ;;
    patch) V_PATCH=$((V_PATCH + 1)) ;;
  esac

  NEW_VERSION="${V_MAJOR}.${V_MINOR}.${V_PATCH}"
  info "Bump ${BUMP}: ${CURRENT_VERSION} -> ${NEW_VERSION}"
fi

# Validate version format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  err "Invalid version format: ${NEW_VERSION}"
  exit 1
fi

# Check tag doesn't already exist
if git rev-parse "v${NEW_VERSION}" &>/dev/null; then
  err "Tag v${NEW_VERSION} already exists"
  exit 1
fi

ok "Version ${NEW_VERSION} is available"

# ============================================================================
# STEP 3: Build & test gate
# ============================================================================

step "Build & test gate (pnpm build && pnpm test && pnpm typecheck && pnpm lint)"
divider

pnpm build
ok "Build passed"

pnpm test
ok "Tests passed"

pnpm typecheck
ok "Type check passed"

pnpm lint
ok "Lint passed"

divider

# ============================================================================
# STEP 4: Bump versions in all package.json files
# ============================================================================

step "Updating package versions to ${NEW_VERSION}"

for pkg_dir in "${PUBLISH_ORDER[@]}"; do
  pkg_json="${pkg_dir}/package.json"
  if [[ ! -f "$pkg_json" ]]; then
    warn "Missing: ${pkg_json} (skipping)"
    continue
  fi

  node -e "
    const fs = require('fs');
    const path = '${pkg_json}';
    const raw = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(raw);
    json.version = '${NEW_VERSION}';
    fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  "
  pkg_name=$(node -p "require('./${pkg_json}').name")
  echo -e "  ${GREEN}+${NC} ${pkg_name} -> ${NEW_VERSION}"
done

# ============================================================================
# STEP 5: Update CHANGELOG.md
# ============================================================================

step "Updating CHANGELOG.md"

RELEASE_DATE=$(date +%Y-%m-%d)

if [[ -f "CHANGELOG.md" ]]; then
  # Insert new version header, replacing "Unreleased" if present
  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('CHANGELOG.md', 'utf8');

    // Replace '[X.Y.Z] - Unreleased' with the dated version
    const unreleasedPattern = /\[${CURRENT_VERSION}\]\s*-\s*Unreleased/i;
    if (unreleasedPattern.test(content)) {
      content = content.replace(unreleasedPattern, '[${NEW_VERSION}] - ${RELEASE_DATE}');
    } else {
      // Prepend a new section after the header
      const insertPoint = content.indexOf('\n## ');
      if (insertPoint !== -1) {
        const before = content.slice(0, insertPoint);
        const after = content.slice(insertPoint);
        content = before + '\n\n## [${NEW_VERSION}] - ${RELEASE_DATE}\n\nReleased from version ${CURRENT_VERSION}.\n' + after;
      } else {
        content += '\n\n## [${NEW_VERSION}] - ${RELEASE_DATE}\n\nFirst release.\n';
      }
    }
    fs.writeFileSync('CHANGELOG.md', content);
  "
  ok "Updated CHANGELOG.md with [${NEW_VERSION}] - ${RELEASE_DATE}"
else
  cat > CHANGELOG.md <<CHANGELOG_EOF
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [${NEW_VERSION}] - ${RELEASE_DATE}

First release.
CHANGELOG_EOF
  ok "Created CHANGELOG.md with [${NEW_VERSION}] - ${RELEASE_DATE}"
fi

# ============================================================================
# STEP 6: Rebuild with new versions (so dist/ reflects updated package.json)
# ============================================================================

step "Rebuilding with updated versions"

pnpm build
ok "Rebuild complete"

# ============================================================================
# STEP 7: Confirmation gate
# ============================================================================

step "Publish plan"
echo ""
echo -e "  ${BOLD}Version:${NC}  ${NEW_VERSION}"
echo -e "  ${BOLD}Tag:${NC}      v${NEW_VERSION}"
echo -e "  ${BOLD}Branch:${NC}   ${CURRENT_BRANCH}"
echo -e "  ${BOLD}Dry run:${NC}  ${DRY_RUN}"
echo ""
echo -e "  ${BOLD}Packages to publish (${#PUBLISH_ORDER[@]}):${NC}"
echo ""

for pkg_dir in "${PUBLISH_ORDER[@]}"; do
  pkg_json="${pkg_dir}/package.json"
  if [[ -f "$pkg_json" ]]; then
    pkg_name=$(node -p "require('./${pkg_json}').name")
    echo -e "    ${CYAN}${pkg_name}${NC}@${NEW_VERSION}"
  fi
done

echo ""
divider

if $DRY_RUN; then
  info "Dry run — skipping confirmation prompt"
else
  echo ""
  echo -e "  ${YELLOW}${BOLD}This will publish ${#PUBLISH_ORDER[@]} packages to npm and push a git tag.${NC}"
  echo ""
  read -rp "  Proceed? (yes/no): " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    err "Aborted by user"
    # Revert version bumps
    git checkout -- .
    exit 1
  fi
fi

# ============================================================================
# STEP 8: Git commit and tag
# ============================================================================

step "Creating git commit and tag"

git add -A
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

ok "Committed and tagged v${NEW_VERSION}"

# ============================================================================
# STEP 9: Publish packages
# ============================================================================

step "Publishing packages"

PUBLISHED=()
FAILED=()

for pkg_dir in "${PUBLISH_ORDER[@]}"; do
  pkg_json="${pkg_dir}/package.json"
  if [[ ! -f "$pkg_json" ]]; then
    warn "Missing: ${pkg_json} (skipping)"
    continue
  fi

  pkg_name=$(node -p "require('./${pkg_json}').name")

  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run]${NC} ${pkg_name}@${NEW_VERSION}"
    # Run pnpm publish --dry-run to validate
    if (cd "$pkg_dir" && pnpm publish --dry-run --no-git-checks 2>&1); then
      PUBLISHED+=("$pkg_name")
    else
      warn "Dry-run publish issue for ${pkg_name}"
      FAILED+=("$pkg_name")
    fi
  else
    echo -ne "  Publishing ${pkg_name}@${NEW_VERSION}... "
    if (cd "$pkg_dir" && pnpm publish --access public --no-git-checks 2>&1); then
      echo -e "${GREEN}done${NC}"
      PUBLISHED+=("$pkg_name")
    else
      echo -e "${RED}FAILED${NC}"
      FAILED+=("$pkg_name")
      err "Failed to publish ${pkg_name}"
    fi
  fi
done

# ============================================================================
# STEP 10: Push (unless dry-run)
# ============================================================================

if $DRY_RUN; then
  step "Dry run complete"
  echo ""
  echo -e "  ${YELLOW}Skipped:${NC} git push and npm publish"
  echo -e "  ${YELLOW}Note:${NC}    Version bumps were committed locally. To undo:"
  echo ""
  echo -e "    git reset --soft HEAD~1"
  echo -e "    git tag -d v${NEW_VERSION}"
  echo -e "    git checkout -- ."
  echo ""
else
  step "Pushing to remote"

  git push origin HEAD
  git push origin "v${NEW_VERSION}"

  ok "Pushed commit and tag v${NEW_VERSION}"
fi

# ============================================================================
# Summary
# ============================================================================

step "Release summary"
echo ""
echo -e "  ${BOLD}Version:${NC}    ${NEW_VERSION}"
echo -e "  ${BOLD}Published:${NC}  ${#PUBLISHED[@]} packages"
echo -e "  ${BOLD}Failed:${NC}     ${#FAILED[@]} packages"
echo ""

if [[ ${#PUBLISHED[@]} -gt 0 ]]; then
  echo -e "  ${GREEN}Published:${NC}"
  for p in "${PUBLISHED[@]}"; do
    echo -e "    ${GREEN}+${NC} ${p}@${NEW_VERSION}"
  done
  echo ""
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo -e "  ${RED}Failed:${NC}"
  for p in "${FAILED[@]}"; do
    echo -e "    ${RED}x${NC} ${p}"
  done
  echo ""
  err "Some packages failed to publish. You can retry individual packages:"
  echo ""
  echo "  cd <package-dir> && pnpm publish --access public --no-git-checks"
  echo ""
  exit 1
fi

if ! $DRY_RUN; then
  echo -e "  ${GREEN}${BOLD}Release v${NEW_VERSION} published successfully!${NC}"
  echo ""
  echo -e "  View on npm: ${CYAN}https://www.npmjs.com/org/orgloop${NC}"
fi
