/**
 * Latest published release, fetched from the GitHub API at build time.
 *
 * Build-time rather than client-side on purpose: the site ships no JavaScript,
 * and an `<img>` badge from a third-party service would both break that promise
 * and hand every visitor's IP to someone else. The trade-off is that the value
 * is only as fresh as the last build — which is why `.github/workflows/pages.yml`
 * also triggers on `release: published`, so cutting a release redeploys the site.
 *
 * This must never fail the build. No releases yet, a rate-limited runner, or an
 * offline developer are all normal; the page simply omits the version and still
 * links to the releases page.
 */
const REPO = "leplusorg/catchme";
const TIMEOUT_MS = 10_000;

export default async function () {
  const unavailable = { available: false, tag: null, url: null, publishedAt: null };

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": `${REPO} site build`,
  };
  // Raises the unauthenticated 60/hour limit, which shared CI runners can
  // otherwise exhaust. Optional: absent locally, and the request still works.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );

    if (response.status === 404) {
      console.log("[site] no published release yet — omitting the version");
      return unavailable;
    }
    if (!response.ok) {
      console.warn(`[site] release lookup failed (HTTP ${response.status}) — omitting the version`);
      return unavailable;
    }

    const data = await response.json();
    return {
      available: Boolean(data.tag_name),
      tag: data.tag_name ?? null,
      url: data.html_url ?? null,
      publishedAt: data.published_at ?? null,
    };
  } catch (error) {
    console.warn(`[site] release lookup errored (${error.message}) — omitting the version`);
    return unavailable;
  }
}
