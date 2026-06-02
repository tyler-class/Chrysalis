#!/usr/bin/env node
/**
 * Chrysalis cross-browser build.
 *
 * Emits a fully-formed, unpacked extension into dist/<target> for each target
 * browser from ONE shared source tree. The only things that differ per target
 * are the merged manifest (manifests/manifest.base.json + the per-target
 * override) and the webextension-polyfill shim that esbuild inlines into every
 * bundle. All business logic, content scripts, and background logic are shared.
 *
 * Usage:
 *   node scripts/build.mjs            # build all targets
 *   node scripts/build.mjs chrome     # build only chrome
 *   node scripts/build.mjs firefox    # build only firefox
 */
import esbuild from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALL_TARGETS = ['chrome', 'firefox'];

// esbuild target strings keep output syntax within what each browser floor
// supports. Firefox floor is 128 (the first version with scripting.executeScript
// `world: "MAIN"`, which the ProjectionLab sync depends on).
const ESBUILD_TARGET = {
  chrome: ['chrome110'],
  firefox: ['firefox128'],
};

// One esbuild entrypoint per loaded script context. Each is bundled into a
// single self-contained IIFE with the polyfill inlined, so e.g. the background
// works as a Chrome service_worker AND a Firefox event-page script, and the
// content script works whether declared statically or injected via
// scripting.executeScript({ files: [...] }).
const ENTRYPOINTS = [
  'background/service-worker.js',
  'content-scripts/monarch.js',
  'popup/popup.js',
  'setup/setup.js',
  'sync-history/sync-history.js',
];

// Static (non-JS) assets copied verbatim into each build.
const STATIC_FILES = [
  'popup/popup.html',
  'setup/setup.html',
  'sync-history/sync-history.html',
];
const STATIC_DIRS = ['icons'];

const POLYFILL_INJECT = path.join(ROOT, 'scripts/inject/webext-polyfill.js');

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function buildManifest(target, outDir) {
  const base = JSON.parse(
    await readFile(path.join(ROOT, 'manifests/manifest.base.json'), 'utf8')
  );
  const override = JSON.parse(
    await readFile(path.join(ROOT, `manifests/manifest.${target}.json`), 'utf8')
  );
  const merged = deepMerge(base, override);
  await writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(merged, null, 2) + '\n'
  );
}

async function buildTarget(target) {
  const outDir = path.join(ROOT, 'dist', target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: ENTRYPOINTS.map((entry) => ({
      in: path.join(ROOT, entry),
      out: entry.replace(/\.js$/, ''),
    })),
    outdir: outDir,
    bundle: true,
    format: 'iife',
    target: ESBUILD_TARGET[target],
    inject: [POLYFILL_INJECT],
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  for (const file of STATIC_FILES) {
    const dest = path.join(outDir, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(ROOT, file), dest);
  }
  for (const dir of STATIC_DIRS) {
    await cp(path.join(ROOT, dir), path.join(outDir, dir), { recursive: true });
  }

  await buildManifest(target, outDir);
  console.log(`✓ Built dist/${target}`);
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : ALL_TARGETS;
  for (const target of targets) {
    if (!ALL_TARGETS.includes(target)) {
      throw new Error(
        `Unknown target "${target}". Valid targets: ${ALL_TARGETS.join(', ')}`
      );
    }
  }
  for (const target of targets) {
    await buildTarget(target);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
