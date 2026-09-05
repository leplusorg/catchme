/**
 * Extension metadata read straight from the VS Code manifest at build time.
 *
 * The commands and settings tables on the docs page are generated from this, so
 * the manifest stays the single source of truth. A hand-copied table drifts the
 * moment someone adds a setting, and drifts *silently* — nothing fails, the docs
 * are just quietly wrong. That already happened once to the Marketplace listing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(HERE, "../../../packages/core/package.json");

const stringify = (value) =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

export default function () {
  const pkg = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const contributes = pkg.contributes ?? {};

  // Menu placement is the useful part for a reader: "where do I find this?".
  const menus = contributes.menus ?? {};
  const placement = (id) => {
    if ((menus["editor/context"] ?? []).some((m) => m.command === id)) {
      return "Editor context menu";
    }
    if ((menus["view/title"] ?? []).some((m) => m.command === id)) {
      return "Exception Flow view toolbar";
    }
    if ((menus["view/item/context"] ?? []).some((m) => m.command === id)) {
      return "Right-click a result";
    }
    return "Result node";
  };

  return {
    id: `${pkg.publisher}.${pkg.name}`,
    displayName: pkg.displayName,
    vscodeVersion: pkg.engines?.vscode ?? "",
    commands: (contributes.commands ?? []).map((c) => ({
      id: c.command,
      title: `${c.category}: ${c.title}`,
      where: placement(c.command),
    })),
    settings: Object.entries(contributes.configuration?.properties ?? {}).map(
      ([id, schema]) => ({
        id,
        default: stringify(schema.default),
        description:
          schema.description ??
          // markdownDescription can contain backticks and links; the table cell
          // renders it as Markdown, so pass it through untouched.
          schema.markdownDescription ??
          "",
      }),
    ),
  };
}
