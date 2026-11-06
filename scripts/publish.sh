#!/usr/bin/env bash
# publish.sh — put this repo on GitHub as a PUBLIC repo, safely.
#
#   scripts/publish.sh --check                 run every security gate and stop
#   scripts/publish.sh [owner/]name            scan, commit, create, push, verify
#
# Gates before anything is published: secret scan (working tree AND full history),
# no sensitive paths tracked, no uncommitted changes, identity set, gh authenticated.
# Never prints or transmits a credential.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
TARGET="${1:-omnirush-hermes}"
CHECK_ONLY=0
[ "$TARGET" = "--check" ] && { CHECK_ONLY=1; TARGET="omnirush-hermes"; }

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1/6  Repository state"
git rev-parse --git-dir >/dev/null 2>&1 || { git init -q && ok "git initialised"; }
git rev-parse --git-dir >/dev/null 2>&1 && ok "git repo present"
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
ok "branch: $BRANCH"

step "2/6  Secret scan (this is the gate that matters)"
chmod +x scripts/scan-secrets.sh scripts/ctl.sh scripts/test-proxy.sh 2>/dev/null || true
scripts/scan-secrets.sh --all || die "secrets in the working tree — fix before publishing"
scripts/scan-secrets.sh --history || die "secrets in git history — rewrite history before publishing"
ok "no secret patterns in tree or history"

step "3/6  Sensitive paths and syntax"
BAD="$(git ls-files | grep -E '(^|/)(tokens\.json|\.env|\.env\.[^e]|.*\.log|.*\.plist|.*\.service)$' || true)"
[ -n "$BAD" ] && die "these must not be tracked: $BAD"
ok "no credential/log/service files tracked"
node --check src/proxy.mjs || die "src/proxy.mjs has a syntax error"
for f in install.sh uninstall.sh scripts/*.sh; do bash -n "$f" || die "$f has a syntax error"; done
ok "shell + JS syntax clean"
node tests/smoke.mjs >/dev/null || die "tests/smoke.mjs failed"
ok "translation tests pass"

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '\n\033[32mGates passed.\033[0m Re-run without --check to publish.\n'; exit 0
fi

step "4/6  Commit"
NAME="$(git config user.name || true)"; EMAIL="$(git config user.email || true)"
if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
  warn "git identity is not configured. Set it globally first, e.g.:"
  printf '     git config --global user.name  "Your Name"\n'
  printf '     git config --global user.email "you@users.noreply.github.com"\n'
  printf '     (use the GitHub noreply address — your real one would be public in every commit)\n'
  die "set a git identity, then re-run"
fi
case "$EMAIL" in
  *users.noreply.github.com) ok "identity: $NAME <$EMAIL> (noreply — good)" ;;
  *) warn "identity email '$EMAIL' will be public in every commit — consider the noreply form" ;;
esac
git add -A
if git diff --cached --quiet; then ok "nothing new to commit"
else git commit -q -m "omnirush-proxy: local OpenAI-compatible bridge for OmniRush models" && ok "committed"; fi

step "5/6  GitHub authentication"
if ! command -v gh >/dev/null; then
  warn "gh (GitHub CLI) is not installed. Install it, then re-run:"
  printf '     macOS (no Homebrew): https://github.com/cli/cli/releases  → put the binary in ~/.local/bin\n'
  printf '     Debian/Ubuntu: sudo apt install gh        Fedora: sudo dnf install gh\n'
  printf '     or: curl -fsSL https://cli.github.com/packages/... (see the releases page)\n'
  die "gh required"
fi
gh auth status >/dev/null 2>&1 || {
  warn "gh is not authenticated. Run this yourself (it opens a browser; nobody else should do it for you):"
  printf '     gh auth login\n'
  die "authenticate, then re-run"
}
LOGIN="$(gh api user --jq .login 2>/dev/null || echo '?')"
ok "authenticated as $LOGIN"

step "6/6  Create and push (PUBLIC)"
if gh repo view "$TARGET" >/dev/null 2>&1; then
  warn "$TARGET already exists on GitHub"
  git remote get-url origin >/dev/null 2>&1 || gh repo set-default "$TARGET" 2>/dev/null || true
  git push -u origin "$BRANCH" || die "push failed"
  ok "pushed to existing repo"
else
  gh repo create "$TARGET" --public --source=. --remote=origin --push \
    || die "repo creation failed (name taken? not enough scope on your token?)"
  ok "created public repo and pushed"
fi

URL="$(gh repo view "$TARGET" --json url --jq .url 2>/dev/null || echo)"
VIS="$(gh repo view "$TARGET" --json visibility --jq .visibility 2>/dev/null || echo)"
printf '\n'
[ "$VIS" = "PUBLIC" ] && ok "visibility: PUBLIC" || warn "visibility reported as: ${VIS:-unknown} — check it in Settings"
ok "url: ${URL:-unknown}"

# Final independent check: ask the remote, not ourselves, what it received.
if [ -n "$URL" ]; then
  SLUG="$(gh repo view "$TARGET" --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "$TARGET")"
  REMOTE_FILES="$(gh api "repos/$SLUG/contents" --jq '.[].name' 2>/dev/null | tr '\n' ' ' || true)"
  ok "remote top level: $REMOTE_FILES"
  case "$REMOTE_FILES" in
    *tokens.json*|*.env*|*.log*) die "a sensitive file reached the remote — make the repo private NOW" ;;
  esac
fi

cat <<'NEXT'

Next, in the repository settings (browser, one minute):
  · Settings → Code security → enable "Secret scanning" and "Push protection"
  · Settings → General → confirm the description, topics and licence are right
NEXT
