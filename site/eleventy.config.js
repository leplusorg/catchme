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
