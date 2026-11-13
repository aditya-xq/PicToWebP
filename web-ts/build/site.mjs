/**
 * The single source of truth for where the site is published.
 *
 * Both the build-time generator (`build/agent-surfaces.ts`) and the build-time
 * validator (`scripts/validate-agent-surfaces.mjs`) import these values, so a
 * host change is a one-line edit instead of a hunt through generated manifests
 * and hand-written markdown.
 *
 * Keep this in sync with `web-ts/index.html` (`rel="canonical"`, `og:url`) and
 * `web-ts/public/{robots.txt,sitemap.xml}`, which still advertise
 * `https://xqbuilds.com/pictowebp/`.
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
