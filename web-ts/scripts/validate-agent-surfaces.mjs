#!/usr/bin/env node
/**
 * Verifies that the built site still publishes a valid agent surface.
 *
 * The `llms.txt` format and the two discovery manifests are checked strictly
 * on purpose: Lighthouse treats a *present but malformed* `llms.txt` or
 * `ard.json` as a failure, while a missing one is "not applicable". Publishing
 * a broken file is therefore worse than publishing none, so this guard runs in
 * CI before anything is deployed.
 *
 * When the repository sources are absent (a vendored `web-ts/`, a stripped
 * container stage) the generator skips and this script skips with it. That is
 * distinct from a missing *output* next to present sources, which is a real
 * regression and fails.
 *
 * Usage: node scripts/validate-agent-surfaces.mjs [dist]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANONICAL_URL, PUBLISH_BASE, PUBLISH_ORIGIN } from '../build/site.mjs'

const SKILLS_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'
const URN = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const SKILL_NAME = /^[a-z0-9-]{1,64}$/
const SKILL = 'pictowebp'

/** A file list item: any markdown bullet, a link, and optional trailing notes. */
const FILE_LIST_ITEM = /^[-*+] \[[^\]]+\]\([^)]+\)/

const dist = path.resolve(process.argv[2] ?? 'dist')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function read(relative) {
  const file = path.join(dist, relative)
  if (!existsSync(file)) {
    failures.push(`missing ${relative}`)
    return null
  }
  return readFileSync(file, 'utf8')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Resolves a `/`-separated path inside `dist`, matching every segment with
 * exact case. `existsSync` alone is case-insensitive on Windows and macOS, so a
 * link that works locally would 404 on GitHub Pages; comparing against the
 * real directory entries keeps this check identical on every OS.
 */
function distEntry(relative) {
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.')
  let current = dist
  for (const segment of segments) {
    if (!existsSync(current)) return null
    const match = readdirSync(current).find((name) => name === segment)
    if (match === undefined) return null
    current = path.join(current, match)
  }
  return current
}

function checkDistPath(relative, href, label) {
  const target = distEntry(relative)
  if (relative === '' || relative === '.') {
    check(existsSync(dist), `${label} points at ${href}, but the build output is missing`)
    return
  }
  check(
    target !== null && statSync(target).isFile(),
    `${label} points at ${href}, which is not in the build`,
  )
}

/**
 * Resolves a published link to a file in `dist`, or to `null` when the link
 * leaves the site. Links on the site's own origin are always checked: one that
 * points outside the project subpath, or at a path with different casing, is a
 * broken link rather than an external one.
 */
function checkTarget(href, fromDir, label) {
  if (href.startsWith('#')) return

  if (/^https?:\/\//i.test(href)) {
    let url
    try {
      url = new URL(href)
    } catch {
      failures.push(`${label}: ${href} is not a valid URL`)
      return
    }
    if (url.origin !== PUBLISH_ORIGIN) return
    if (!url.pathname.startsWith(PUBLISH_BASE)) {
      failures.push(`${label}: ${href} is on the site origin but outside ${PUBLISH_BASE}`)
      return
    }
    checkDistPath(url.pathname.slice(PUBLISH_BASE.length), href, label)
    return
  }

  if (href.startsWith('/')) {
    checkDistPath(href.replace(/^\/+/, ''), href, label)
    return
  }

  checkDistPath(path.posix.relative(path.posix.dirname(fromDir), href.split('#')[0]), href, label)
}

// --- skip when this is not a full checkout --------------------------------

const sources = ['llms.txt', 'agent/pictowebp/SKILL.md', 'docs/agent-contract.md']
const missingSources = sources.filter((source) => !existsSync(path.join(repo, source)))

if (missingSources.length > 0) {
  console.warn(
    `agent surfaces: skipped, repository sources not found (${missingSources.join(', ')}); ` +
      'the build ran outside a full checkout',
  )
  process.exit(0)
}

// --- llms.txt -------------------------------------------------------------

const llms = read('llms.txt')

if (llms !== null) {
  const text = llms.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  const firstLine = lines.find((line) => line.trim() !== '') ?? ''

  check(/^# \S/.test(firstLine), 'llms.txt must start with an H1 naming the site')
  check(
    lines.some((line) => line.trim().startsWith('> ')),
    'llms.txt must contain a blockquote summary',
  )

  // Every H2 section is a "file list": list items, each a markdown link.
  const sections = text.split(/^## /m).slice(1)
  check(sections.length > 0, 'llms.txt must have at least one H2 file list')
  for (const section of sections) {
    const [heading, ...body] = section.split(/\r?\n/)
    for (const line of body) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      check(
        FILE_LIST_ITEM.test(trimmed),
        `llms.txt section "${heading}": expected a "[name](url)" list item, got "${trimmed}"`,
      )
    }
  }

  for (const [, href] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    checkTarget(href, '.', 'llms.txt')
  }
}

// --- llms-full.txt and the markdown twin ----------------------------------

const full = read('llms-full.txt')
if (full !== null) {
  check(full.length > 4000, 'llms-full.txt looks too small to be the full reference')
  check(full.startsWith('# PicToWebP'), 'llms-full.txt must start with the project H1')
}
read('index.html.md')

// --- the verbatim catalog -------------------------------------------------

read('agent/index.json')
read('agent/agent-contract.md')
const publishedSkill = read(`.well-known/agent-skills/${SKILL}/SKILL.md`)
if (publishedSkill !== null) {
  check(/^---\r?\n/.test(publishedSkill), 'published SKILL.md is missing YAML frontmatter')
  check(
    new RegExp(`^name:\\s*${SKILL}$`, 'm').test(publishedSkill),
    `published SKILL.md frontmatter must declare name: ${SKILL}`,
  )
}

// --- .well-known/agent-skills/index.json ----------------------------------

const indexDir = '.well-known/agent-skills'
const indexRaw = read(path.posix.join(indexDir, 'index.json'))
let skillsIndex = null
if (indexRaw !== null) {
  try {
    skillsIndex = JSON.parse(indexRaw)
  } catch (error) {
    failures.push(`.well-known/agent-skills/index.json is not valid JSON: ${error.message}`)
  }
}

if (skillsIndex) {
  check(skillsIndex.$schema === SKILLS_INDEX_SCHEMA, `skills index $schema must be ${SKILLS_INDEX_SCHEMA}`)
  check(Array.isArray(skillsIndex.skills) && skillsIndex.skills.length > 0, 'skills index has no skills')
  for (const skill of skillsIndex.skills ?? []) {
    check(SKILL_NAME.test(skill.name ?? ''), `skills index: invalid skill name "${skill.name}"`)
    check(['skill-md', 'archive'].includes(skill.type), `skills index: invalid type for ${skill.name}`)
    check(typeof skill.description === 'string' && skill.description.length > 20, `skills index: ${skill.name} needs a description`)
    check(DIGEST.test(skill.digest ?? ''), `skills index: ${skill.name} needs a sha256 digest`)
    check(typeof skill.url === 'string', `skills index: ${skill.name} needs a url`)

    const relative = skill.url && /^https?:\/\//.test(skill.url)
      ? null
      : path.posix.normalize(path.posix.join(indexDir, skill.url ?? ''))
    if (relative) {
      const file = distEntry(relative)
      check(file !== null, `skills index: ${skill.name} url ${skill.url} is not in the build`)
      if (file !== null && DIGEST.test(skill.digest ?? '')) {
        check(
          `sha256:${sha256(file)}` === skill.digest,
          `skills index: digest for ${skill.name} does not match ${relative}`,
        )
      }
    }
  }
}

// --- .well-known/ard.json -------------------------------------------------

const ardRaw = read('.well-known/ard.json')
let ard = null
if (ardRaw !== null) {
  try {
    ard = JSON.parse(ardRaw)
  } catch (error) {
    failures.push(`.well-known/ard.json is not valid JSON: ${error.message}`)
  }
}

if (ard) {
  check(Array.isArray(ard.entries) && ard.entries.length > 0, 'ard.json has no entries')
  check(!('collections' in ard), 'ard.json must not have a top-level collections field')
  for (const entry of ard.entries ?? []) {
    check(URN.test(entry.identifier ?? ''), `ard.json: identifier "${entry.identifier}" is not a urn:air URN`)
    check(typeof entry.displayName === 'string' && entry.displayName.length > 0, `ard.json: ${entry.identifier} needs a displayName`)
    check(MEDIA_TYPE.test(entry.type ?? ''), `ard.json: ${entry.identifier} has an invalid media type "${entry.type}"`)
    check(Boolean(entry.url) !== Boolean(entry.data), `ard.json: ${entry.identifier} needs exactly one of url or data`)
    if (entry.url) checkTarget(entry.url, '.well-known', `ard.json (${entry.identifier})`)
  }
}

// --- the page itself ------------------------------------------------------

const html = read('index.html')
if (html !== null) {
  check(/rel="ard"/.test(html), 'index.html must link rel="ard" to the discovery manifest')
  check(/rel="describedby"/.test(html), 'index.html must link rel="describedby" to llms.txt')
  check(/type="text\/markdown"/.test(html), 'index.html must advertise the markdown twin')
  check(!html.includes('__BASE__'), 'index.html still contains an unreplaced __BASE__ token')
  check(/Content-Security-Policy/.test(html), 'index.html is missing the CSP meta tag')

  // Self-references name the public page, which is the branded host, not the
  // Pages deploy the artifacts are served from. `build/site.mjs` is the one
  // place either can change.
  const selfReferences = [
    ['rel="canonical"', /<link rel="canonical" href="([^"]+)"/],
    ['og:url', /<meta property="og:url" content="([^"]+)"/],
    ['og:image', /<meta property="og:image" content="([^"]+)"/],
    ['JSON-LD url', /"url":\s*"([^"]+)"/],
  ]
  for (const [name, pattern] of selfReferences) {
    const found = pattern.exec(html)
    check(found !== null, `index.html is missing ${name}`)
    if (found) {
      const expected = name === 'og:image' ? `${CANONICAL_URL}og-image.png` : CANONICAL_URL
      check(found[1] === expected, `${name} must be ${expected}, got ${found[1]}`)
    }
  }

  // The `#cli` section must not become a second source of truth for the CLI:
  // every flag it names has to be documented in the normative contract.
  // Scoped to that section so `docker run --rm` and installer flags in `#local`
  // are not mistaken for converter flags.
  const cliSection = /<section id="cli"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  check(cliSection !== '', 'index.html is missing the #cli section')
  const contract = readFileSync(path.join(repo, 'docs', 'agent-contract.md'), 'utf8')
  for (const [flag] of new Set([...cliSection.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0])).entries()) {
    check(
      contract.includes(flag),
      `#cli names ${flag}, which docs/agent-contract.md does not document`,
    )
  }
}

// The static files Vite copies verbatim must agree with the same host.
const sitemap = read('sitemap.xml')
if (sitemap !== null) {
  check(sitemap.includes(`<loc>${CANONICAL_URL}</loc>`), `sitemap.xml must list ${CANONICAL_URL}`)
}

const robots = read('robots.txt')
if (robots !== null) {
  check(
    robots.includes(`${CANONICAL_URL}sitemap.xml`),
    `robots.txt must point at ${CANONICAL_URL}sitemap.xml`,
  )
}

// --- report ---------------------------------------------------------------

if (failures.length > 0) {
  console.error(`agent surfaces: ${failures.length} problem(s) in ${dist}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('agent surfaces: ok')
