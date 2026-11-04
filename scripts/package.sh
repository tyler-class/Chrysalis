#!/usr/bin/env bash
# Build Chrysalis from source and check the result.
#
#   scripts/package.sh            # tests + build + checks
#   scripts/package.sh --no-tests # skip `node --test`
#
# Output (in dist/, which git ignores):
#   dist/chrysalis-<version>/      folder to use with Chrome's "Load unpacked"
#   dist/chrysalis-<version>.zip   the same files zipped, for the Chrome Web Store
#
# Only what the extension loads is included (allowlist below). Tests, scripts, screenshots and
# README are left out. The build fails on missing files referenced by the manifest/HTML/imports
# or a syntax error in any shipped JS. Needs Node 18+ and zip.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SHIP=(manifest.json background content-scripts icons popup setup shared sync-history)
# Files inside SHIP dirs that the extension never loads (source art for generate-icons.js).
EXCLUDE=(icons/logo-full.jpg icons/logo-small.jpg)

VERSION="$(node -p "require('./manifest.json').version")"
OUT_DIR="$ROOT/dist"
STAGE="$OUT_DIR/chrysalis-$VERSION"
ZIP="$OUT_DIR/chrysalis-$VERSION.zip"

fail() { echo "FAIL: $*" >&2; exit 1; }

if [[ "${1:-}" != "--no-tests" ]]; then
  echo "== Tests"
  node --test tests/*.test.js >/dev/null || { node --test tests/*.test.js; fail "tests failed"; }
  echo "   ok"
fi

echo "== Stage $VERSION"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
for p in "${SHIP[@]}"; do [[ -e "$p" ]] || fail "missing $p"; cp -R "$p" "$STAGE/"; done
for f in "${EXCLUDE[@]}"; do rm -f "$STAGE/$f"; done
find "$STAGE" -name '.DS_Store' -delete

echo "== Reference check"
node - "$STAGE" <<'NODE'
const fs = require('fs'), path = require('path');
const stage = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const refs = new Set();
const add = (from, rel) => refs.add(path.normalize(path.join(path.dirname(from), rel)));
Object.values(m.icons || {}).forEach((p) => add('manifest.json', p));
Object.values((m.action && m.action.default_icon) || {}).forEach((p) => add('manifest.json', p));
if (m.action && m.action.default_popup) add('manifest.json', m.action.default_popup);
if (m.options_ui && m.options_ui.page) add('manifest.json', m.options_ui.page);
if (m.background && m.background.service_worker) add('manifest.json', m.background.service_worker);
(m.content_scripts || []).forEach((c) => (c.js || []).concat(c.css || []).forEach((p) => add('manifest.json', p)));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const abs of walk(stage)) {
  const rel = path.relative(stage, abs);
  if (!/\.(html|js)$/.test(rel)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const re = /(?:src|href)="([^"#:]+)"|import\s+(?:[^'"]*from\s+)?['"](\.{1,2}\/[^'"]+)['"]|getURL\(\s*['"]([^'"]+)['"]/g;
  let x;
  while ((x = re.exec(src))) {
    const r = x[1] || x[2] || x[3];
    if (!r || r.includes('${') || r.startsWith('//') || r.startsWith('data:')) continue;
    if (x[3]) refs.add(path.normalize(r.replace(/^\//, ''))); else add(rel, r);
  }
}
const missing = [...refs].filter((r) => !fs.existsSync(path.join(stage, r)));
if (missing.length) { console.error('Missing from package:\n  ' + missing.join('\n  ')); process.exit(1); }
console.log('   ok (' + refs.size + ' references)');
NODE

echo "== Syntax check"
while IFS= read -r f; do
  if head -c 4000 "$f" | grep -qE '^\s*(import|export)\s'; then
    node --check --input-type=module < "$f" 2>/dev/null || { node --check --input-type=module < "$f"; fail "syntax: $f"; }
  else
    node --check "$f" || fail "syntax: $f"
  fi
done < <(find "$STAGE" -name '*.js')
echo "   ok"

echo "== Zip"
( cd "$STAGE" && zip -qrX "$ZIP" . )
echo "   Load unpacked: $STAGE"
echo "   Web Store zip: $ZIP ($(du -h "$ZIP" | cut -f1), $(unzip -Z1 "$ZIP" | wc -l | tr -d ' ') files)"
