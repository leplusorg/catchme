/**
 * Eleventy configuration for the CatchMe homepage.
 *
 * Deliberately minimal: no plugins, no bundler, no client-side JavaScript. Every
 * page is rendered to plain HTML at build time and the only other asset is one
 * hand-written stylesheet.
 *
 * The site is a GitHub Pages *project* page, so it is served from
 * `/catchme/` rather than the domain root. That makes `pathPrefix` load-bearing:
 * Eleventy does not rewrite hardcoded paths, so every internal reference must go
 * through the `url` filter (`{{ "/styles.css" | url }}`). A bare `/styles.css`
 * would resolve to the domain root and 404 - the single most common reason a
 * freshly published Pages site looks unstyled.
 */
export default function (eleventyConfig) {
  // Copied verbatim rather than processed — there is no CSS pipeline on purpose.
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  /*
   * Renders the inline Markdown that VS Code allows in a manifest
   * `markdownDescription`, for text that lands in a hand-written `<table>` on
   * the docs page. Those cells used to be Markdown table cells, which markdown-it
   * rendered for free — but a Nunjucks loop cannot live inside a Markdown table
   * (see the note in src/docs.md), so the table is raw HTML now and the cells
   * are not parsed by anything.
   *
   * Escaping happens first and unconditionally, so the output is safe to mark
   * `| safe` at the call site; the two replacements below only ever add tags
   * around text that has already been neutralised. Code spans and links are the
   * whole of what VS Code documents for `markdownDescription` and the whole of
   * what the manifest actually uses — anything richer belongs in a real Markdown
   * pipeline rather than a wider regex here.
   */
  eleventyConfig.addFilter("mdInline", (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>'),
  );

  // Tells crawlers the canonical host and keeps the two in sync with one edit.
  eleventyConfig.addGlobalData("site", {
    name: "CatchMe",
    tagline: "Exception Flow Explorer for Visual Studio Code",
    url: "https://leplusorg.github.io/catchme",
    repo: "https://github.com/leplusorg/catchme",
    // Derived from `repo` so there is one place to change if it ever moves.
    // `issues/new/choose` lands on the template picker rather than a blank box,
    // which is the point of having bug/feature/question templates at all.
    issues: "https://github.com/leplusorg/catchme/issues",
    releases: "https://github.com/leplusorg/catchme/releases",
    newIssue: "https://github.com/leplusorg/catchme/issues/new/choose",
    contributing:
      "https://github.com/leplusorg/catchme/blob/main/CONTRIBUTING.md",
    security: "https://github.com/leplusorg/catchme/blob/main/SECURITY.md",
    providerApi: "https://github.com/leplusorg/catchme/tree/main/packages/api",
    marketplace:
      "https://marketplace.visualstudio.com/items?itemName=leplusorg.catchme",
    openvsx: "https://open-vsx.org/extension/leplusorg/catchme",
  });

  return {
    // Served from https://leplusorg.github.io/catchme/ - see the note above.
    pathPrefix: "/catchme/",
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
