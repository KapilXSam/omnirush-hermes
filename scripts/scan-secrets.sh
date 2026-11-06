#!/usr/bin/env bash
# scan-secrets.sh — dependency-free secret scan of tracked files (and, with --history,
# of every commit). Exits non-zero on a hit. Used as a pre-push gate and by publish.sh.
#
#   scripts/scan-secrets.sh              scan tracked working-tree files
#   scripts/scan-secrets.sh --history    also scan every commit's diff
#   scripts/scan-secrets.sh --all        scan the whole working tree (not just tracked)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
MODE="${1:-tracked}"

# Patterns that should never appear in a public repo.
#   sk-omnirush is an intentional local dummy and is excluded explicitly.
PATTERNS=(
  'omr_[A-Za-z0-9_-]{20,}'                 # OmniRush refresh tokens
  'omnirush-[a-f0-9]{20,}'                 # OmniRush access tokens
  'ghp_[A-Za-z0-9]{20,}'                   # GitHub PAT (classic)
  'github_pat_[A-Za-z0-9_]{20,}'           # GitHub PAT (fine-grained)
  'gho_[A-Za-z0-9]{20,}'                   # GitHub OAuth
  'sk-[A-Za-z0-9]{20,}'                    # OpenAI-style keys
  'sk-ant-[A-Za-z0-9_-]{20,}'              # Anthropic
  'AKIA[0-9A-Z]{16}'                       # AWS access key id
  'xox[baprs]-[A-Za-z0-9-]{10,}'           # Slack
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'  # JWTs
  'BEGIN [A-Z ]*PRIVATE KEY'
  '"refreshToken" *: *"[^"]'               # a token store that got committed
  '"accessToken" *: *"[^"]'
)
# Informational only — never a build failure by itself.
SOFT_PATTERNS=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|dev)'  # personal email in content
)

hits=0
scan_targets() {
  if [ "$MODE" = "--all" ]; then
    find . -type f -not -path './.git/*' -print0
  else
    git ls-files -z
  fi
}

echo "== scanning $( [ "$MODE" = "--all" ] && echo 'working tree' || echo 'tracked files' ) =="
# Inline escape hatch for deliberate fixtures. Two documented forms:
#   · a line carrying the marker `omnirush:allow-secret-scan`
#   · the exact placeholder value `omr_invalid_token_for_tests` used by tests/server.mjs
ALLOW='omnirush:allow-secret-scan|omr_invalid_token_for_tests'
for pat in "${PATTERNS[@]}"; do
  found="$(scan_targets | xargs -0 grep -nEI -- "$pat" 2>/dev/null \
            | grep -v 'sk-omnirush' | grep -vE "$ALLOW" || true)"
  if [ -n "$found" ]; then
    printf '\033[31mHIT\033[0m pattern: %s\n%s\n' "$pat" "$found"
    hits=$((hits+1))
  fi
done

# Ignored-but-tracked files are the usual leak vector. Example/template env files are fine.
if git rev-parse --git-dir >/dev/null 2>&1; then
  bad="$(git ls-files | grep -E '(^|/)(tokens\.json|\.env|\.env\..*|.*\.log|.*\.plist|.*\.service)$' \
          | grep -vE '(^|/)\.env\.(example|sample|template)$' || true)"
  [ -n "$bad" ] && { printf '\033[31mHIT\033[0m sensitive paths tracked:\n%s\n' "$bad"; hits=$((hits+1)); }
fi

if [ "$MODE" = "--history" ]; then
  echo "== scanning git history =="
  for pat in "${PATTERNS[@]}"; do
    found="$(git log -p --all 2>/dev/null | grep -nEI -- "$pat" \
              | grep -v 'sk-omnirush' | grep -vE "$ALLOW" | head -5 || true)"
    [ -n "$found" ] && { printf '\033[31mHIT\033[0m history pattern %s\n%s\n' "$pat" "$found"; hits=$((hits+1)); }
  done
fi

echo "== informational (not failures) =="
for pat in "${SOFT_PATTERNS[@]}"; do
  found="$(scan_targets | xargs -0 grep -nEIoh -- "$pat" 2>/dev/null | sort -u | head -5 || true)"
  [ -n "$found" ] && printf '\033[33mNOTE\033[0m possible address in content:\n%s\n' "$found"
done

if [ "$hits" -gt 0 ]; then
  printf '\n\033[31m%d secret pattern(s) found — do NOT publish.\033[0m\n' "$hits"
  exit 1
fi
printf '\n\033[32mNo secrets found.\033[0m\n'
