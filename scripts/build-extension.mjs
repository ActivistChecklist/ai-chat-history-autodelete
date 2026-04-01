/**
 * Production packaging for the Chrome extension (MV3).
 *
 * Approach (aligned with common extension + security practice):
 * - Allowlist-only copy: only known runtime files go into dist/ (no broad "copy src/").
 * - Fresh Tailwind build so shipped CSS is minified and matches input.css.
 * - Store-ready .zip with manifest.json at the archive root (Chrome Web Store / "Load unpacked" checks).
 * - Never copies dev-only trees (tests, discovery, node_modules, Tailwind source, env files, keys).
 *
 * Usage:
 *   yarn build              # CSS + dist/ + release/*.zip
 *   yarn build -- --no-zip  # dist/ only
 *   yarn build -- --skip-css
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

/** Every file the extension loads at runtime — update when you add modules or static assets. */
const ALLOWLISTED_FILES = [
  'manifest.json',
  'src/background.js',
  'src/content/top-bar.js',
  'src/content/top-bar.css',
  'src/options/options.html',
  'src/options/options.js',
  'src/onboarding/onboarding.html',
  'src/onboarding/onboarding.js',
  'src/shared/alarms.js',
  'src/shared/constants.js',
  'src/shared/bar-insertion.js',
  'src/shared/pending-deletion-modal.js',
  'src/shared/run-frequency-fieldset.js',
  'src/shared/run-threshold.js',
  'src/shared/storage.js',
  'src/providers/claude.js',
  'src/providers/registry.js',
  'src/styles/auto-delete.css'
];

const FORBIDDEN_NAMES = ['.env', '.pem', '.key', 'credentials'];

function parseArgs(argv) {
  const set = new Set(argv);
  return {
    noZip: set.has('--no-zip'),
    skipCss: set.has('--skip-css')
  };
}

function assertSafeSourcePath(absPath, label) {
  const rel = path.relative(ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path (${label}): ${absPath}`);
  }
  if (FORBIDDEN_NAMES.some((n) => rel.split(path.sep).includes(n))) {
    throw new Error(`Refusing to package forbidden segment in path: ${rel}`);
  }
}

function copyAllowlistedFile(relPath) {
  const src = path.join(ROOT, relPath);
  assertSafeSourcePath(src, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required file (update allowlist or restore file): ${relPath}`);
  }
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${relPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${relPath}`);
  }
  const dest = path.join(DIST, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyIcons() {
  const iconsDir = path.join(ROOT, 'icons');
  assertSafeSourcePath(iconsDir, 'icons');
  if (!fs.existsSync(iconsDir)) {
    throw new Error('Missing icons/ directory');
  }
  const destRoot = path.join(DIST, 'icons');
  fs.mkdirSync(destRoot, { recursive: true });
  for (const name of fs.readdirSync(iconsDir)) {
    if (!name.endsWith('.png')) continue;
    const src = path.join(iconsDir, name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink: icons/${name}`);
    }
    if (!st.isFile()) continue;
    fs.copyFileSync(src, path.join(destRoot, name));
  }
}

function runTailwindBuild() {
  const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
  const r = spawnSync(yarn, ['build:css'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`Tailwind build failed with exit ${r.status}`);
  }
}

function validateManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const m = JSON.parse(raw);
  if (m.manifest_version !== 3) {
    throw new Error('manifest.json must be manifest_version 3');
  }
  if (!m.name || !m.version) {
    throw new Error('manifest.json must include name and version');
  }
  const csp = m.content_security_policy?.extension_pages;
  if (typeof csp === 'string' && csp.includes('unsafe-eval')) {
    throw new Error('Refusing to ship extension_pages CSP containing unsafe-eval');
  }
  return m;
}

function zipDist(version) {
  const safeVersion = String(version).replace(/[^0-9a-z._-]+/gi, '-');
  const zipName = `ai-chat-history-auto-delete-${safeVersion}.zip`;
  const zipPath = path.join(RELEASE, zipName);
  fs.mkdirSync(RELEASE, { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => {
      console.log(`\nZip: ${zipPath} (${archive.pointer()} bytes)`);
      resolve(zipPath);
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(DIST, false);
    archive.finalize();
  });
}

async function main() {
  const { noZip, skipCss } = parseArgs(process.argv.slice(2));

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  if (!skipCss) {
    console.log('Running Tailwind (minify)…');
    runTailwindBuild();
  }

  console.log('Copying allowlisted extension files…');
  for (const rel of ALLOWLISTED_FILES) {
    copyAllowlistedFile(rel);
  }
  copyIcons();

  const builtManifest = path.join(DIST, 'manifest.json');
  const manifest = validateManifest(builtManifest);

  console.log(`dist/ ready — load unpacked from:\n  ${DIST}`);

  if (!noZip) {
    await zipDist(manifest.version);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
