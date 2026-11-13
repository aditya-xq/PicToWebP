/**
 * Publishes the agent-facing surface of the site into the build output.
 *
 * Everything here is static: no runtime network calls, nothing dynamic, and
 * nothing that the strict CSP has to allow. The artefacts are generated from
 * files that already exist in the repository so the published copies cannot
 * drift from `agent/`, `docs/agent-contract.md` or `llms.txt`.
 *
 * Produced in `dist/` (and `dist-python/`):
 *
 *   agent/                                  verbatim copy of the repo catalog
 *   agent/agent-contract.md                 normative CLI/agent contract
 *   llms.txt                                compact agent entry point
 *   llms-full.txt                           single-file concatenation
 *   .well-known/agent-skills/index.json     Agent Skills Discovery index
 *   .well-known/agent-skills/pictowebp/     the installable skill
 *   .well-known/ard.json                    Agentic Resource Discovery manifest
 *   .nojekyll                               keep dot-directories on Pages
 *
 * See `docs/web-revamp-research.md` for why each of these exists.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import { publishUrl } from './site.mjs'

/** Agent Skills Discovery index schema (Cloudflare RFC, v0.2.0). */
const SKILLS_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

const SKILL_NAME = 'pictowebp'

/**
 * Repository files the surface is built from. When they are absent the build is
 * running outside a full checkout (vendored `web-ts/`, a stripped container
 * stage) and the surface is skipped rather than failing the build.
 */
const REQUIRED_SOURCES = ['agent/pictowebp/SKILL.md', 'docs/agent-contract.md', 'llms.txt']

/** Files concatenated into `llms-full.txt`, in reading order. */
const FULL_TEXT_SOURCES: Array<{ file: string; title: string }> = [
  { file: 'docs/agent-contract.md', title: 'Agent contract (normative)' },
  { file: 'agent/pictowebp/SKILL.md', title: 'Agent skill' },
  { file: 'agent/pictowebp/references/install.md', title: 'Install reference' },
  { file: 'agent/pictowebp/references/cli.md', title: 'CLI reference' },
  { file: 'agent/pictowebp/references/json-schema.md', title: 'JSON payload reference' },
  { file: 'agent/pictowebp/references/mcp.md', title: 'MCP reference' },
  { file: 'agent/pictowebp/references/troubleshooting.md', title: 'Troubleshooting' },
]

function readFrontmatterField(markdown: string, field: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return undefined
  for (const line of match[1].split(/\r?\n/)) {
    const entry = new RegExp(`^${field}:\\s*(.+)$`).exec(line.trim())
    if (entry) return entry[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

async function sha256Of(file: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`
}

export function agentSurfaces(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'pictowebp-agent-surfaces',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    async closeBundle() {
      const root = config.root
      const repo = path.resolve(root, '..')
      const out = path.resolve(root, config.build.outDir)

      const missing = REQUIRED_SOURCES.filter((source) => !existsSync(path.join(repo, source)))
      if (missing.length > 0) {
        this.warn(
          `agent surfaces skipped: repository sources not found (${missing.join(', ')}). ` +
            'Build from a full checkout, or copy agent/, llms.txt and docs/agent-contract.md ' +
            'next to web-ts/ (see the Dockerfile).',
        )
        return
      }

      const skillDir = path.join(repo, 'agent', SKILL_NAME)
      const skillMarkdown = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
      const description = readFrontmatterField(skillMarkdown, 'description')
      if (!description) {
        throw new Error('agent/pictowebp/SKILL.md is missing a frontmatter description')
      }

      // Verbatim catalog, so `agent/index.json` keeps working from the site.
      await cp(path.join(repo, 'agent'), path.join(out, 'agent'), { recursive: true })
      await cp(path.join(repo, 'docs', 'agent-contract.md'), path.join(out, 'agent', 'agent-contract.md'))

      // Compact and full agent entry points.
      await cp(path.join(repo, 'llms.txt'), path.join(out, 'llms.txt'))
      const sections = [
        '# PicToWebP , full agent reference',
        '',
        '> Everything an agent needs about PicToWebP in one document: the normative',
        '> CLI contract, the installable skill, and every reference page. Generated',
        '> from the repository at build time.',
        '',
        `Compact version: ${publishUrl('llms.txt')}`,
      ]
      for (const { file, title } of FULL_TEXT_SOURCES) {
        const body = await readFile(path.join(repo, file), 'utf8')
        sections.push('', '---', '', `## ${title}`, '', body.trim(), '')
      }
      await writeFile(path.join(out, 'llms-full.txt'), `${sections.join('\n')}\n`)

      // Agent Skills Discovery: publish the skill where `npx skills add <url>`
      // looks for it, relative to the site root.
      const wellKnown = path.join(out, '.well-known')
      const publishedSkillDir = path.join(wellKnown, 'agent-skills', SKILL_NAME)
      await mkdir(path.join(wellKnown, 'agent-skills'), { recursive: true })
      await cp(skillDir, publishedSkillDir, { recursive: true })

      const skillIndex = {
        $schema: SKILLS_INDEX_SCHEMA,
        skills: [
          {
            name: SKILL_NAME,
            type: 'skill-md',
            description,
            url: `${SKILL_NAME}/SKILL.md`,
            digest: await sha256Of(path.join(publishedSkillDir, 'SKILL.md')),
          },
        ],
      }
      await writeFile(
        path.join(wellKnown, 'agent-skills', 'index.json'),
        `${JSON.stringify(skillIndex, null, 2)}\n`,
      )

      // Agentic Resource Discovery: advertise the skill and the CLI.
      const ard = {
        entries: [
          {
            identifier: 'urn:air:aditya-xq.github.io:pictowebp:skill',
            displayName: 'PicToWebP agent skill',
            type: 'text/markdown',
            url: publishUrl(`.well-known/agent-skills/${SKILL_NAME}/SKILL.md`),
            description,
            tags: ['image', 'webp', 'compression', 'cli', 'offline'],
            capabilities: ['convert_folder', 'convert_image', 'dry_run'],
          },
          {
            identifier: 'urn:air:aditya-xq.github.io:pictowebp:cli',
            displayName: 'PicToWebP CLI',
            type: 'application/octet-stream',
            url: 'https://github.com/aditya-xq/PicToWebP/releases',
            description:
              'Local, offline image-to-WebP converter. Rust and Python editions share one contract: --json, --info, --dry-run, stable exit codes and a stdio MCP server.',
            tags: ['image', 'webp', 'compression', 'cli', 'offline', 'mcp'],
            capabilities: ['info', 'convert', 'mcp'],
          },
        ],
      }
      await writeFile(path.join(wellKnown, 'ard.json'), `${JSON.stringify(ard, null, 2)}\n`)

      // Artifact-based Pages deploys do not run Jekyll, but this keeps the
      // dot-directories safe if the deployment method ever changes.
      await writeFile(path.join(out, '.nojekyll'), '')
    },
    transformIndexHtml() {
      const base = config.base.endsWith('/') ? config.base : `${config.base}/`
      return [
        {
          tag: 'link',
          attrs: {
            rel: 'alternate',
            type: 'text/markdown',
            href: `${base}index.html.md`,
            title: 'Markdown version of this page',
          },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: { rel: 'describedby', href: `${base}llms.txt` },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: { rel: 'ard', href: `${base}.well-known/ard.json` },
          injectTo: 'head',
        },
      ]
    },
  }
}
