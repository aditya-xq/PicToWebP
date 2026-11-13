/**
 * Where the site lives, in one place.
 *
 * Two different hosts matter here and they are not the same:
 *
 * - `PUBLISH_*` is where CI deploys the build and therefore where the agent
 *   artifacts (`llms.txt`, `.well-known/ard.json`, the skill) are actually
 *   served. Every machine-readable URL points here.
 * - `CANONICAL_*` is the public, branded page. `rel="canonical"`, `og:url`,
 *   `og:image`, the JSON-LD `url`, `robots.txt` and `sitemap.xml` name it.
 *   `xqbuilds` vendors this build into `static/pictowebp/` and rewrites the
 *   publish URLs to this host.
 *
 * The build-time validator enforces both, so changing either constant without
 * updating the metadata fails the build instead of shipping a mismatch.
 */
export const PUBLISH_ORIGIN = 'https://aditya-xq.github.io'

/** The Pages project subpath. A project site cannot own the origin root. */
export const PUBLISH_BASE = '/PicToWebP/'

/** Origin plus base, with a guaranteed trailing slash. */
export const PUBLISH_PREFIX = `${PUBLISH_ORIGIN}${PUBLISH_BASE}`

/** Where the page is canonicalised, and where the mirror serves it. */
export const CANONICAL_ORIGIN = 'https://xqbuilds.com'
export const CANONICAL_BASE = '/pictowebp/'
export const CANONICAL_URL = `${CANONICAL_ORIGIN}${CANONICAL_BASE}`

/**
 * Absolute URL for a path published under the Pages build.
 * @param {string} relative
 * @returns {string}
 */
export function publishUrl(relative) {
  return `${PUBLISH_PREFIX}${relative.replace(/^\/+/, '')}`
}
