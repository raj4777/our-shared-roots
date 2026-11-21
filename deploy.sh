#!/usr/bin/env bash
# Our Shared Roots: build, check and deploy to Firebase (macOS / Linux).
# Windows users can run deploy.ps1, which takes the same options.
#
# Usage (from any folder):
#   bash deploy.sh                    # build, check, confirm, deploy everything firebase.json defines
#   bash deploy.sh --dry-run          # do every check and the build, print the firebase commands, deploy nothing
#   bash deploy.sh --test             # also run npm test and the Firestore rules tests first (slow; needs Chrome / Java)
#   bash deploy.sh --only hosting     # hosting | rules | all (default all)
#   bash deploy.sh --preview          # deploy the site to a temporary preview channel instead of live
#   bash deploy.sh --yes              # skip the "type DEPLOY" confirmation
# More: --channel NAME (preview channel, default "preview"), --project ID, --site DIR,
#       --skip-install (do not run npm ci / npm install), -h | --help.
# Or make it executable once: chmod +x deploy.sh, then ./deploy.sh --dry-run
# (zsh users: run it with bash or ./deploy.sh; it does not need to be sourced).

set -euo pipefail

# Firebase project used when .firebaserc is missing. Leave empty to require .firebaserc or --project.
DEFAULT_PROJECT=""

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RUN_TESTS=0
ONLY="all"
PREVIEW=0
CHANNEL="preview"
DRY_RUN=0
ASSUME_YES=0
SKIP_INSTALL=0
PROJECT=""
SITE=""

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf '  WARNING: %s\n' "$*" >&2; }
ok() { printf '  ok  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

need_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value (see --help)."; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --test) RUN_TESTS=1 ;;
    --only) need_value "$@"; ONLY="$2"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --preview) PREVIEW=1 ;;
    --channel) need_value "$@"; CHANNEL="$2"; shift ;;
    --channel=*) CHANNEL="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --project) need_value "$@"; PROJECT="$2"; shift ;;
    --project=*) PROJECT="${1#*=}" ;;
    --site) need_value "$@"; SITE="$2"; shift ;;
    --site=*) SITE="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)." ;;
  esac
  shift
done

case "$ONLY" in hosting|rules|all) ;; *) die "--only must be hosting, rules or all (got '$ONLY')." ;; esac
case "$CHANNEL" in ''|*[!A-Za-z0-9_-]*) die "--channel may only use letters, digits, - and _." ;; esac
if [ "$PREVIEW" -eq 1 ] && [ "$ONLY" = "rules" ]; then
  die "--preview deploys only the site to a preview channel; it cannot be combined with --only rules."
fi

# Where firebase.json lives. Normally this folder; --site points at a separate deploy folder.
if [ -z "$SITE" ]; then SITE="$ROOT"; fi
[ -d "$SITE" ] || die "Site folder not found: $SITE"
SITE="$(cd "$SITE" && pwd)"

echo "Our Shared Roots deploy"
echo "Project folder: $ROOT"
[ "$SITE" = "$ROOT" ] || echo "Deploy folder:  $SITE"
[ "$DRY_RUN" -eq 1 ] && echo "Mode: dry run (nothing will be deployed)"

# ---------------------------------------------------------------------------
step 1 "Check project files."
[ -f "$ROOT/package.json" ] || die "package.json is missing in $ROOT."
ok "package.json"
if [ ! -f "$SITE/firebase.json" ]; then
  CANDIDATES=""
  for d in "$ROOT"/deploy-*/; do
    if [ -f "${d}firebase.json" ]; then d="${d%/}"; CANDIDATES="${CANDIDATES:+$CANDIDATES }${d##*/}"; fi
  done
  if [ -n "$CANDIDATES" ]; then
    die "firebase.json is missing in $SITE. Pass the deploy folder made by setup, e.g. --site ${CANDIDATES%% *} (found: $CANDIDATES)."
  fi
  die "firebase.json is missing in $SITE. Run from the project folder (or pass --site DIR)."
fi
ok "firebase.json"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and re-run."
command -v npm >/dev/null 2>&1 || die "npm is not on PATH (it comes with Node.js)."

# Read firebase.json with Node (no jq needed). Prints: hosting public dir, then the deploy targets.
FB_INFO="$(node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const t = [];
if (cfg.hosting) t.push("hosting");
const fsx = Array.isArray(cfg.firestore) ? cfg.firestore[0] : cfg.firestore;
if (fsx && fsx.rules) t.push("firestore:rules");
if (fsx && fsx.indexes) t.push("firestore:indexes");
const st = Array.isArray(cfg.storage) ? cfg.storage[0] : cfg.storage;
if (st && st.rules) t.push("storage");
const files = [fsx && fsx.rules, fsx && fsx.indexes, st && st.rules].filter(Boolean);
console.log((cfg.hosting && cfg.hosting.public) || "");
console.log(t.join(","));
console.log(files.join(","));
' "$SITE/firebase.json")" || die "firebase.json is not valid JSON."
HOSTING_PUBLIC="$(printf '%s\n' "$FB_INFO" | sed -n 1p)"
ALL_TARGETS="$(printf '%s\n' "$FB_INFO" | sed -n 2p)"
RULE_FILES="$(printf '%s\n' "$FB_INFO" | sed -n 3p)"
[ -n "$ALL_TARGETS" ] || die "firebase.json defines nothing to deploy."
if [ -n "$HOSTING_PUBLIC" ] && [ "$HOSTING_PUBLIC" != "dist" ]; then
  die "firebase.json hosting.public is '$HOSTING_PUBLIC'; this project builds into dist/."
fi
OLD_IFS="$IFS"; IFS=','
for f in $RULE_FILES; do
  [ -f "$SITE/$f" ] || { IFS="$OLD_IFS"; die "firebase.json refers to $f, which is missing."; }
  ok "$f"
done
IFS="$OLD_IFS"

# Project id: --project, else .firebaserc, else DEFAULT_PROJECT.
RC_PROJECT=""
if [ -f "$SITE/.firebaserc" ]; then
  RC_PROJECT="$(node -e '
const rc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log((rc.projects && rc.projects.default) || "");
' "$SITE/.firebaserc")" || die ".firebaserc is not valid JSON."
fi
if [ -z "$PROJECT" ]; then
  if [ -n "$RC_PROJECT" ] && [ -n "$DEFAULT_PROJECT" ] && [ "$RC_PROJECT" != "$DEFAULT_PROJECT" ]; then
    die ".firebaserc names '$RC_PROJECT' but this script expects '$DEFAULT_PROJECT'. Pass --project to choose."
  fi
  PROJECT="${RC_PROJECT:-$DEFAULT_PROJECT}"
fi
[ -n "$PROJECT" ] || die "No Firebase project id. Add .firebaserc or pass --project ID."
case "$PROJECT" in *[!a-z0-9-]*) die "Project id '$PROJECT' looks wrong (lowercase letters, digits and - only)." ;; esac
ok "Firebase project: $PROJECT"

# ---------------------------------------------------------------------------
step 2 "Check tools."
NODE_VER="$(node -p 'process.versions.node')"
NODE_CHECK="$(node -e '
const [a, b] = process.versions.node.split(".").map(Number);
console.log(a < 20 ? "old" : (a < 22 || (a === 22 && b < 12)) ? "warn" : "ok");
')"
case "$NODE_CHECK" in
  old) die "Node $NODE_VER is too old. Vite needs Node 20 or newer (Node 22 LTS recommended)." ;;
  warn) ok "Node $NODE_VER"; warn "Node is older than 22.12; the build works, but the browser tests (--test) may not run." ;;
  *) ok "Node $NODE_VER" ;;
esac
ok "npm $(npm -v)"

FIREBASE_OK=1
if ! command -v firebase >/dev/null 2>&1; then
  FIREBASE_OK=0
  if [ "$DRY_RUN" -eq 1 ]; then warn "Firebase CLI not found (needed for a real deploy): npm install -g firebase-tools"
  else die "Firebase CLI not found. Install it with: npm install -g firebase-tools, then run: firebase login"; fi
else
  ok "Firebase CLI $(firebase --version 2>/dev/null | tail -n 1)"
  LOGIN_OUT="$(firebase login:list 2>&1 || true)"
  if printf '%s' "$LOGIN_OUT" | grep -qi 'logged in as'; then
    ok "$(printf '%s\n' "$LOGIN_OUT" | grep -i 'logged in as' | head -n 1 | sed 's/^[^A-Za-z]*//')"
  else
    FIREBASE_OK=0
    if [ "$DRY_RUN" -eq 1 ]; then warn "Firebase CLI is not logged in (run: firebase login)."
    else die "Firebase CLI is not logged in. Run: firebase login"; fi
  fi
fi

# ---------------------------------------------------------------------------
step 3 "Install dependencies."
if [ "$SKIP_INSTALL" -eq 1 ]; then
  echo "  skipped (--skip-install)"
  [ -d "$ROOT/node_modules" ] || die "node_modules is missing; run without --skip-install."
else
  NPM_LOG="$(mktemp "${TMPDIR:-/tmp}/osr-npm.XXXXXX")"
  if [ -f "$ROOT/package-lock.json" ]; then
    echo "  npm ci"
    npm ci --no-audit --no-fund 2>&1 | tee "$NPM_LOG"
  else
    echo "  npm install"
    npm install --no-audit --no-fund 2>&1 | tee "$NPM_LOG"
  fi
  if grep -qi 'fsevents' "$NPM_LOG"; then
    echo "  Note: the fsevents install-script message above is harmless. fsevents is an optional"
    echo "  macOS file-watcher used only by the dev server; the build does not need it."
  fi
  rm -f "$NPM_LOG"
fi

# ---------------------------------------------------------------------------
find_chrome() {
  if [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -x "${PUPPETEER_EXECUTABLE_PATH}" ]; then return 0; fi
  if [ -n "${CHROME_PATH:-}" ] && [ -x "${CHROME_PATH}" ]; then return 0; fi
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -x "$c" ] && return 0
  done
  command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1
}
has_script() { node -e 'process.exit(require(process.argv[1]).scripts && require(process.argv[1]).scripts[process.argv[2]] ? 0 : 1)' "$ROOT/package.json" "$1"; }

step 4 "Tests."
if [ "$RUN_TESTS" -eq 0 ]; then
  echo "  skipped (add --test to run npm test and the Firestore rules tests first)"
else
  if ! has_script test || [ ! -d "$ROOT/test" ]; then
    warn "No test/ folder or test script here; skipping npm test."
  elif [ "$NODE_CHECK" = "warn" ]; then
    warn "Node $NODE_VER is older than 22.12; skipping the browser tests."
  elif ! find_chrome; then
    warn "Chrome or Chromium not found (set PUPPETEER_EXECUTABLE_PATH); skipping the browser tests."
  else
    echo "  npm test (builds and runs the page tests in headless Chrome; this takes a few minutes)"
    npm test || die "npm test failed. Nothing was deployed."
    ok "npm test passed"
  fi
  if ! has_script test:rules || [ ! -d "$ROOT/rules-test" ]; then
    warn "No rules-test/ folder here; skipping the Firestore rules tests."
  elif ! java -version >/dev/null 2>&1; then
    warn "Java is not installed (the Firestore emulator needs it); skipping the rules tests."
  else
    echo "  npm run test:rules (Firestore emulator)"
    npm run test:rules || die "Firestore rules tests failed. Nothing was deployed."
    ok "rules tests passed"
  fi
fi

# ---------------------------------------------------------------------------
step 5 "Build the production site (npm run build)."
npm run build || die "Build failed. Nothing was deployed."

step 6 "Check the build."
DIST="$ROOT/dist"
[ -f "$DIST/index.html" ] || die "dist/index.html is missing after the build."
ok "dist/index.html"
[ -d "$DIST/assets" ] || die "dist/assets/ is missing after the build."
JS_COUNT="$(find "$DIST/assets" -name '*.js' -type f | wc -l | tr -d ' ')"
[ "$JS_COUNT" -gt 0 ] || die "dist/assets/ has no JavaScript files."
ok "dist/assets ($JS_COUNT JavaScript files)"
HOOK_HITS="$(node -e '
const fs = require("fs"), path = require("path");
const bad = ["__TREE", "__ADMIN", "__MIGRATE", "__OSR_TEST_HOOKS__", "installTestSession", "setTestWrite"];
const hits = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html)$/.test(n)) {
      const s = fs.readFileSync(p, "utf8");
      for (const b of bad) if (s.includes(b)) hits.push(path.relative(process.argv[1], p) + ": " + b);
    }
  }
})(process.argv[1]);
console.log(hits.join("\n"));
' "$DIST")"
[ -z "$HOOK_HITS" ] || die "dist/ contains test hooks; do not deploy a test build:
$HOOK_HITS"
ok "no test hooks in dist/"

if [ "$SITE" != "$ROOT" ]; then
  [ -f "$SITE/dist/config.js" ] || die "$SITE/dist/config.js is missing; re-run setup for that folder."
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  dry run: would copy the new dist/ into $SITE/dist (keeping its config.js)"
  else
    rm -rf "$SITE/dist.new" "$SITE/dist.old"
    cp -R "$DIST" "$SITE/dist.new"
    cp "$SITE/dist/config.js" "$SITE/dist.new/config.js"
    mv "$SITE/dist" "$SITE/dist.old"
    mv "$SITE/dist.new" "$SITE/dist"
    rm -rf "$SITE/dist.old"
    ok "copied the new dist/ into $SITE/dist (kept config.js)"
  fi
fi

# ---------------------------------------------------------------------------
step 7 "Deploy."
TARGETS=""
OLD_IFS="$IFS"; IFS=','
for t in $ALL_TARGETS; do
  case "$ONLY:$t" in
    all:*|hosting:hosting|rules:firestore:rules|rules:firestore:indexes|rules:storage) TARGETS="${TARGETS:+$TARGETS,}$t" ;;
  esac
done
IFS="$OLD_IFS"
if [ "$PREVIEW" -eq 1 ]; then
  case ",$ALL_TARGETS," in *,hosting,*) ;; *) die "firebase.json has no hosting section to preview." ;; esac
  DESC="the site to preview channel '$CHANNEL' (expires in 7 days; it uses the LIVE database and rules)"
  set -- firebase hosting:channel:deploy "$CHANNEL" --project "$PROJECT" --expires 7d
else
  [ -n "$TARGETS" ] || die "Nothing to deploy for --only $ONLY with this firebase.json."
  DESC="$TARGETS to the LIVE project"
  set -- firebase deploy --project "$PROJECT" --only "$TARGETS"
fi
echo "  Will deploy $DESC:"
echo "    (cd \"$SITE\" && $*)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "Dry run finished. Nothing was deployed."
  [ "$FIREBASE_OK" -eq 1 ] || echo "Before a real deploy: install the Firebase CLI and run firebase login."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  [ -t 0 ] || die "No terminal to confirm in. Re-run with --yes to deploy without the prompt."
  printf '\nType DEPLOY to publish to %s: ' "$PROJECT"
  read -r ANSWER
  [ "$ANSWER" = "DEPLOY" ] || die "Deploy cancelled. Nothing was deployed."
fi

(cd "$SITE" && "$@") || die "firebase reported an error (see above)."

echo ""
echo "Deploy finished."
echo ""
echo "After deploying:"
echo "  1. Super Admin: sign in and make one small edit (any save). That save writes the"
echo "     protected adminEmails list; then check Admin > People & access for the Admin roles."
echo "  2. Reload (or close) tabs that were open before this deploy, on every device. Old tabs"
echo "     run the old code and will say someone else saved first."
echo "  3. Test on your phone: open the site, sign in, check the tree loads and an edit saves."
echo "  4. Smoke-check: /  /admin.html  /admin  /migrate-log.html"
if [ "$PREVIEW" -eq 1 ]; then
  echo "  The preview URL is printed above. It talks to the live database: test carefully."
fi
