/**
 * The "Exception Flow" tree.
 *
 * Shape: the exception, then one node per **destination** (a handler, an
 * uncaught boundary, or an unresolved depth limit), then the call chain that
 * reaches it. Grouping by destination rather than by path matches the order
 * people ask the questions — "where can it end up?" before "how does it get
 * there?" — and collapses the common case where several call chains converge on
 * one handler.
 *
 * A chain reads origin-first, like a stack trace whose innermost frame is the
 * throw:
 *
 *     🔥 IOException                       Repo.java:42
 *     ↑  Repo.load()         called at Service.java:71
 *     ✓  catch (IOException e)          Service.java:88
 */
import * as vscode from "vscode";
import type {
  Confidence,
  FlowResult,
  PropagationPath,
  Sink,
} from "@leplusorg/catchme-api";

type Node =
  | { readonly t: "root"; readonly result: FlowResult }
  | {
      readonly t: "destination";
      readonly group: Destination;
      readonly result: FlowResult;
    }
  | {
      readonly t: "path";
      readonly path: PropagationPath;
      readonly result: FlowResult;
    }
  | { readonly t: "origin"; readonly result: FlowResult }
  | { readonly t: "hop"; readonly sink: Sink }
  | { readonly t: "library"; readonly sinks: readonly Sink[] }
  | { readonly t: "truncated"; readonly path: PropagationPath };

interface Destination {
  readonly key: string;
  /** Representative terminal; undefined for the truncated group. */
  readonly terminal: Sink | undefined;
  readonly paths: readonly PropagationPath[];
}

/**
 * Grouping key for chains that stopped at a bound instead of a real terminal.
 *
 * Real keys are JSON arrays and so always begin with `[`; this sentinel cannot
 * collide with one. It was previously a NUL-prefixed string, which worked but
 * made git treat this entire file as binary - no diffs, no blame.
 */
const TRUNCATED_KEY = "#truncated";

// ---------------------------------------------------------------------------
// grouping and confidence
// ---------------------------------------------------------------------------

const lineOf = (l: vscode.Location): number => l.range.start.line;
const shortName = (uri: vscode.Uri): string =>
  uri.path.split("/").pop() ?? uri.path;
const at = (l: vscode.Location): string =>
  `${shortName(l.uri)}:${lineOf(l) + 1}`;

/** A chain is only as trustworthy as its shakiest hop. */
function pathConfidence(path: PropagationPath): Confidence {
  return path.steps.some((s) => s.confidence === "possible")
    ? "possible"
    : "definite";
}

/** First step that cost the chain its certainty, if any. */
function weakestStep(path: PropagationPath): Sink | undefined {
  return path.steps.find((s) => s.confidence === "possible");
}

/**
 * Reachability is a question of *any* route: a destination reached by one
 * definite chain is definitely reachable, even if other chains are shaky.
 */
function destinationConfidence(group: Destination): Confidence {
  return group.paths.some((p) => pathConfidence(p) === "definite")
    ? "definite"
    : "possible";
}

function groupByDestination(result: FlowResult): Destination[] {
  const byKey = new Map<
    string,
    { terminal: Sink | undefined; paths: PropagationPath[] }
  >();

  for (const path of result.paths) {
    const terminal = path.truncated
      ? undefined
      : path.steps[path.steps.length - 1];
    const key =
      path.truncated || !terminal
        ? TRUNCATED_KEY
        : // JSON rather than a delimiter-joined string: a URI can contain almost
          // any character, so any separator we chose would need escaping to stay
          // unambiguous. JSON already solves that, and stays readable in a debugger.
          JSON.stringify([
            terminal.kind,
            terminal.location.uri.toString(),
            lineOf(terminal.location),
          ]);

    const entry = byKey.get(key) ?? { terminal, paths: [] };
    entry.paths.push(path);
    byKey.set(key, entry);
  }

  return [...byKey.entries()]
    .map(([key, v]) => ({ key, terminal: v.terminal, paths: v.paths }))
    .sort(rankDestination);
}

/** Caught first, then uncaught, then unresolved — most actionable at the top. */
function rankDestination(a: Destination, b: Destination): number {
  const rank = (d: Destination) =>
    d.key === TRUNCATED_KEY
      ? 3
      : d.terminal?.kind === "caught"
        ? 0
        : d.terminal?.kind === "uncaught"
          ? 1
          : 2;
  return rank(a) - rank(b);
}

/** Library code has no workspace folder; used to fold noisy frames away. */
function isLibrary(location: vscode.Location): boolean {
  return vscode.workspace.getWorkspaceFolder(location.uri) === undefined;
}

/**
 * Expand one path into its display rows: origin, hops (consecutive library
 * frames folded), the destination, and a truncation marker when the search was
 * cut short.
 */
function rowsFor(path: PropagationPath, result: FlowResult): Node[] {
  const rows: Node[] = [{ t: "origin", result }];
  let libraryRun: Sink[] = [];

  const flushLibrary = () => {
    if (libraryRun.length > 0) {
      rows.push({ t: "library", sinks: libraryRun });
      libraryRun = [];
    }
  };

  for (const sink of path.steps) {
    if (sink.kind === "escapes-function" && isLibrary(sink.location)) {
      libraryRun.push(sink);
      continue;
    }
    flushLibrary();
    rows.push({ t: "hop", sink });
  }
  flushLibrary();

  if (path.truncated) rows.push({ t: "truncated", path });
  return rows;
}

// ---------------------------------------------------------------------------
// stack-trace formatting (also used by the copy command)
// ---------------------------------------------------------------------------

export type FlowNode = Node;

/**
 * Which chains a copy action should serialise for a given node. Copying a
 * destination yields every route to it; copying the root yields everything.
 */
export function pathsForCopy(
  node: FlowNode | undefined,
): { paths: readonly PropagationPath[]; result: FlowResult } | undefined {
  if (!node) return undefined;
  switch (node.t) {
    case "root":
      return { paths: node.result.paths, result: node.result };
    case "destination":
      return { paths: node.group.paths, result: node.result };
    case "path":
      return { paths: [node.path], result: node.result };
    default:
      return undefined;
  }
}

export function formatPathAsStackTrace(
  path: PropagationPath,
  result: FlowResult,
): string {
  const { throwSite } = result;
  const lines = [
    `${throwSite.exceptionType.id}${throwSite.simulated ? " (simulated)" : ""}`,
    `    thrown at ${at(new vscode.Location(throwSite.uri, throwSite.range))}`,
  ];
  for (const sink of path.steps) {
    const where = sink.callSite ? ` (called at ${at(sink.callSite)})` : "";
    const mark = sink.confidence === "possible" ? " [possible]" : "";
    lines.push(`    at ${sink.label} — ${at(sink.location)}${where}${mark}`);
  }
  if (path.truncated)
    lines.push("    ... stopped at the configured depth limit");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

export class FlowTreeDataProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private result: FlowResult | undefined;
  private readonly changed = new vscode.EventEmitter<Node | undefined>();

  readonly onDidChangeTreeData: vscode.Event<Node | undefined> =
    this.changed.event;

  setResult(result: FlowResult): void {
    this.result = result;
    this.changed.fire(undefined);
  }

  clear(): void {
    this.result = undefined;
    this.changed.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    const result = this.result;
    if (!result) return [];

    if (!element) return [{ t: "root", result }];

    switch (element.t) {
      case "root":
        return groupByDestination(result).map((group) => ({
          t: "destination",
          group,
          result,
        }));

      case "destination": {
        const { paths } = element.group;
        // One chain needs no intermediate node — show its rows directly.
        const first = paths[0];
        if (paths.length === 1 && first) return rowsFor(first, element.result);
        return paths.map((path) => ({
          t: "path",
          path,
          result: element.result,
        }));
      }

      case "path":
        return rowsFor(element.path, element.result);

      case "library":
        return element.sinks.map((sink) => ({ t: "hop", sink }));

      default:
        return [];
    }
  }

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.t) {
      case "root":
        return this.rootItem(element.result);
      case "destination":
        return this.destinationItem(element.group);
      case "path":
        return this.pathItem(element.path);
      case "origin":
        return this.originItem(element.result);
      case "hop":
        return this.hopItem(element.sink);
      case "library":
        return this.libraryItem(element.sinks);
      case "truncated":
        return this.truncatedItem(element.path);
    }
  }

  // -------------------------------------------------------------- item builders

  private rootItem(result: FlowResult): vscode.TreeItem {
    const groups = groupByDestination(result);
    const destinations = groups.filter((g) => g.key !== TRUNCATED_KEY).length;
    const item = new vscode.TreeItem(
      result.throwSite.exceptionType.label,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.description = `${destinations} destination${destinations === 1 ? "" : "s"} · ${result.paths.length} path${result.paths.length === 1 ? "" : "s"}${result.partial ? " · partial" : ""}`;
    item.iconPath = new vscode.ThemeIcon(
      result.throwSite.simulated ? "beaker" : "flame",
    );
    item.tooltip = result.throwSite.exceptionType.id;
    item.contextValue = "catchme.root";
    return item;
  }

  private destinationItem(group: Destination): vscode.TreeItem {
    if (group.key === TRUNCATED_KEY) {
      const item = new vscode.TreeItem(
        "unresolved — depth limit reached",
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${group.paths.length} path${group.paths.length === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      item.contextValue = "catchme.destination";
      return item;
    }

    const terminal = group.terminal!;
    const confidence = destinationConfidence(group);
    const item = new vscode.TreeItem(
      terminal.label,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.description = `${at(terminal.location)} · ${confidence}`;
    item.iconPath = iconFor(terminal.kind, confidence);
    item.tooltip = new vscode.MarkdownString(
      `**${terminal.label}**\n\n${at(terminal.location)}\n\nReachable via ${group.paths.length} path(s); ` +
        (confidence === "definite"
          ? "at least one is a certain match."
          : "every route involves an approximation."),
    );
    item.command = openCommand(terminal.location);
    item.contextValue = "catchme.destination";
    return item;
  }

  private pathItem(path: PropagationPath): vscode.TreeItem {
    const via = path.steps
      .filter((s) => s.kind === "escapes-function")
      .map((s) =>
        s.label
          .replace(/^escapes (method |function )?/, "")
          .replace(/[''"]/g, ""),
      );
    const confidence = pathConfidence(path);
    const item = new vscode.TreeItem(
      via.length > 0 ? `via ${via.join(" → ")}` : "direct",
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const weak = weakestStep(path);
    item.description =
      `${path.depth} hop${path.depth === 1 ? "" : "s"}` +
      (confidence === "possible" ? " · possible" : "") +
      (path.truncated ? " · partial" : "");
    item.iconPath = new vscode.ThemeIcon(
      confidence === "definite" ? "list-flat" : "question",
    );
    if (weak) {
      item.tooltip = new vscode.MarkdownString(
        `Certainty limited by **${weak.label}**${weak.reason ? ` — ${weak.reason}` : ""}.`,
      );
    }
    item.contextValue = "catchme.path";
    return item;
  }

  private originItem(result: FlowResult): vscode.TreeItem {
    const { throwSite } = result;
    const item = new vscode.TreeItem(
      `${throwSite.simulated ? "simulated " : "throw "}${throwSite.exceptionType.label}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const location = new vscode.Location(throwSite.uri, throwSite.range);
    item.description = at(location);
    item.iconPath = new vscode.ThemeIcon(
      throwSite.simulated ? "beaker" : "flame",
    );
    item.command = openCommand(location);
    item.contextValue = "catchme.step";
    return item;
  }

  private hopItem(sink: Sink): vscode.TreeItem {
    const item = new vscode.TreeItem(
      sink.label,
      vscode.TreeItemCollapsibleState.None,
    );
    // The call site is the interesting jump target for an escaping frame: it is
    // where the exception actually leaves for the next frame.
    const target = sink.callSite ?? sink.location;
    item.description = sink.callSite
      ? `called at ${at(sink.callSite)}`
      : at(sink.location);
    item.iconPath = iconFor(sink.kind, sink.confidence);
    item.command = openCommand(target);
    item.tooltip = new vscode.MarkdownString(
      `**${sink.label}**\n\n${at(sink.location)}` +
        (sink.callSite ? `\n\nCalled at ${at(sink.callSite)}` : "") +
        (sink.reason ? `\n\n_${sink.reason}_` : ""),
    );
    item.contextValue = "catchme.step";
    return item;
  }

  private libraryItem(sinks: readonly Sink[]): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `… ${sinks.length} library frame${sinks.length === 1 ? "" : "s"}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon("library");
    item.tooltip = "Frames outside the workspace. Expand to inspect.";
    item.contextValue = "catchme.library";
    return item;
  }

  private truncatedItem(path: PropagationPath): vscode.TreeItem {
    const item = new vscode.TreeItem(
      "depth limit reached — expand further",
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `stopped at ${path.depth} hop${path.depth === 1 ? "" : "s"}`;
    item.iconPath = new vscode.ThemeIcon("debug-continue-small");
    item.command = {
      command: "catchme.expandPath",
      title: "Expand further",
      arguments: [path.depth],
    };
    item.contextValue = "catchme.truncated";
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

// ---------------------------------------------------------------------------

function openCommand(location: vscode.Location): vscode.Command {
  return {
    command: "vscode.open",
    title: "Reveal",
    arguments: [location.uri, { selection: location.range }],
  };
}

function iconFor(kind: Sink["kind"], confidence: Confidence): vscode.ThemeIcon {
  switch (kind) {
    case "caught":
      return new vscode.ThemeIcon(
        confidence === "definite" ? "pass-filled" : "question",
      );
    case "escapes-function":
      return new vscode.ThemeIcon("arrow-up");
    case "uncaught":
      return new vscode.ThemeIcon("error");
    case "unknown":
    default:
      return new vscode.ThemeIcon("circle-slash");
  }
}
