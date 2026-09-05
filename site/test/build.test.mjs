/**
 * Guards the properties the site is supposed to have, rather than its wording.
 *
 * The "no JavaScript, no third-party requests" promise is easy to break by
 * accident — one analytics snippet or one web font pulled from a CDN and it is
 * quietly untrue. These checks fail the build instead.
 *
 * Run after `eleventy`: `pnpm --filter @leplusorg/catchme-site test`
 */
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '_site');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + ' -> ' + e.message);
    fail++;
  }
};

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = path.join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (!existsSync(SITE)) {
  console.error(`no build output at ${SITE} — run \`pnpm --filter @leplusorg/catchme-site build\` first`);
  process.exit(1);
}

const files = walk(SITE);
const html = files.filter((f) => f.endsWith('.html'));
const index = readFileSync(path.join(SITE, 'index.html'), 'utf8');

console.log('site build checks\n');

check('renders an index page', () => assert.ok(html.length > 0));

check('ships no JavaScript', () => {
  const js = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.deepStrictEqual(js, [], 'unexpected JS: ' + js.join(', '));
  for (const f of html) {
    assert.ok(!/<script/i.test(readFileSync(f, 'utf8')), `<script> in ${path.basename(f)}`);
  }
});

// A page that silently reaches a CDN is no longer self-contained, and the
// footer's privacy claim stops being true. Only *asset* positions count:
// outbound <a> links are the point of the page, and canonical/og:url are
// self-references on our own origin.
const OWN_ORIGIN = 'https://leplusorg.github.io';
const ASSET_POSITIONS = [
  /<img[^>]+src="(https?:\/\/[^"]+)"/gi,
  /<script[^>]+src="(https?:\/\/[^"]+)"/gi,
  /<link[^>]+rel="(?:stylesheet|preload|preconnect|dns-prefetch)"[^>]*href="(https?:\/\/[^"]+)"/gi,
  /<iframe[^>]+src="(https?:\/\/[^"]+)"/gi,
];

check('loads no third-party assets', () => {
  const offenders = [];
  for (const f of [...html, path.join(SITE, 'styles.css')]) {
    const text = readFileSync(f, 'utf8');
    const found = f.endsWith('.css')
      ? [...text.matchAll(/(?:@import\s+|url\()\s*["']?(https?:\/\/[^"')]+)/gi)].map((m) => m[1])
      : ASSET_POSITIONS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
    offenders.push(...found.filter((u) => !u.startsWith(OWN_ORIGIN)));
  }
  assert.deepStrictEqual(offenders, [], 'remote assets: ' + offenders.join(', '));
});

// The site is served from /catchme/, not the domain root. Eleventy does not
// rewrite hardcoded paths, so a bare `/styles.css` silently 404s in production
// while looking fine in local preview - exactly the bug this guards.
check('prefixes every internal asset path with the base path', () => {
  const bare = [];
  for (const f of html) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
      const url = m[1];
      if (url !== '/catchme/' && !url.startsWith('/catchme/')) bare.push(url);
    }
  }
  assert.deepStrictEqual(bare, [], 'paths missing the /catchme/ prefix: ' + bare.join(', '));
});

check('resolves the stylesheet and icon under the base path', () => {
  const index = readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.ok(index.includes('href="/catchme/styles.css"'), 'stylesheet not prefixed');
  assert.ok(index.includes('/catchme/assets/icon.png'), 'icon not prefixed');
});

check('copies the stylesheet and icon', () => {
  assert.ok(existsSync(path.join(SITE, 'styles.css')), 'styles.css missing');
  assert.ok(existsSync(path.join(SITE, 'assets/icon.png')), 'assets/icon.png missing');
});

// A project homepage that does not route people to the tracker just generates
// support requests somewhere worse - email, or nowhere at all.
check('routes contributors to the repo, tracker and policies', () => {
  const required = {
    'issue tracker': '/leplusorg/catchme/issues',
    'new-issue template picker': '/issues/new/choose',
    'contributing guide': 'CONTRIBUTING.md',
    'security policy': 'SECURITY.md',
    'releases': '/leplusorg/catchme/releases',
    'source': 'github.com/leplusorg/catchme',
  };
  const missing = Object.entries(required)
    .filter(([, needle]) => !index.includes(needle))
    .map(([what]) => what);
  assert.deepStrictEqual(missing, [], 'homepage does not link to: ' + missing.join(', '));
});

// The version is fetched at build time, so "no releases yet" and "API was
// unreachable" are both normal. What must never happen is the build failing, or
// the page rendering a broken/empty version line.
check('renders the version block in whichever state applies', () => {
  const shown = /Latest release/.test(index);
  if (shown) {
    assert.ok(
      /Latest release\s*<a href="[^"]+"><code>[^<]+<\/code><\/a>/.test(index),
      'version line present but malformed — expected a tag linking to the release',
    );
  } else {
    assert.ok(
      /<p class="version">\s*<a href="[^"]*releases"/.test(index),
      'no release found, so the version block should fall back to a Releases link',
    );
  }
});

// The docs tables are generated from packages/core/package.json. If that link
// ever breaks the page still renders - just with empty tables - so compare the
// rendered rows against the manifest rather than trusting the build to fail.
check('docs page documents every command and setting in the manifest', () => {
  const docs = readFileSync(path.join(SITE, 'docs', 'index.html'), 'utf8');
  const manifest = JSON.parse(
    readFileSync(path.resolve(SITE, '../../packages/core/package.json'), 'utf8'),
  );
  const missing = [
    ...Object.keys(manifest.contributes.configuration.properties),
    ...manifest.contributes.commands.map((c) => c.title),
  ].filter((needle) => !docs.includes(needle));
  assert.deepStrictEqual(missing, [], 'docs page is missing: ' + missing.join(', '));
});

check('docs page is reachable from the site nav', () => {
  assert.ok(/href="\/catchme\/docs\/"/.test(index), 'no Docs link in the nav');
});

check('sets a canonical URL and a description', () => {
  assert.ok(/rel="canonical"/.test(index), 'no canonical link');
  assert.ok(/<meta name="description" content=".{40,}"/.test(index), 'missing/short description');
});

// A shared canonical across pages tells search engines the docs page is a
// duplicate of the homepage, and it gets dropped from the index.
check('each page declares its own canonical URL', () => {
  const seen = new Map();
  for (const f of html) {
    const m = /rel="canonical" href="([^"]+)"/.exec(readFileSync(f, 'utf8'));
    assert.ok(m, `no canonical in ${path.relative(SITE, f)}`);
    const dupe = seen.get(m[1]);
    assert.ok(!dupe, `${path.relative(SITE, f)} shares a canonical with ${dupe}`);
    seen.set(m[1], path.relative(SITE, f));
  }
});

check('has exactly one h1', () => {
  assert.strictEqual((index.match(/<h1[\s>]/g) || []).length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
