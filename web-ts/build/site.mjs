/**
 * The single source of truth for where the site is published.
 *
 * Both the build-time generator (`build/agent-surfaces.ts`) and the build-time
 * validator (`scripts/validate-agent-surfaces.mjs`) import these values, so a
 * host change is a one-line edit here. The validator then enforces the rest:
 * `index.html` (`rel="canonical"`, `og:url`, `og:image`, JSON-LD),
 * `public/robots.txt` and `public/sitemap.xml` must all agree with this file,
 * and the build fails if they don't.
 */
export const SITE_ORIGIN = 'https://aditya-xq.github.io'

/** The Pages project subpath. A project site cannot own the origin root. */
export const SITE_BASE = '/PicToWebP/'

/** Origin plus base, with a guaranteed trailing slash. */
export const SITE_PREFIX = `${SITE_ORIGIN}${SITE_BASE}`

/**
 * Absolute URL for a path published under the site root.
 * @param {string} relative
 * @returns {string}
 */
export function siteUrl(relative) {
  return `${SITE_PREFIX}${relative.replace(/^\/+/, '')}`
}
