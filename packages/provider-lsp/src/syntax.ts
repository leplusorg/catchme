/**
 * A deliberately small, dependency-free syntactic scanner for brace-style
 * languages.
 *
 * This is not a parser and does not pretend to be one. It exists so the generic
 * provider can answer "which `catch` encloses this offset?" for any C-like
 * language without shipping a grammar per language. Everything it produces is
 * therefore reported as `possible`, never `definite` — see the provider.
 *
 * The one thing it does take seriously is **not being fooled by text**:
 * `stripNonCode` blanks out comments and string literals before any scanning,
 * so a `catch` inside a string or a `//` comment cannot create a phantom
 * handler. Offsets are preserved so every index maps back to the original.
 */

export interface CatchClause {
  /** Offset of the `catch` keyword. */
  readonly start: number;
  readonly end: number;
  /** Type names in the clause header, e.g. `['IOException']`, or `[]` for a bare catch. */
  readonly typeNames: readonly string[];
}

export interface TryBlock {
  /** Offset of the `try` keyword. */
  readonly start: number;
  /** Body braces, exclusive of the braces themselves. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly catches: readonly CatchClause[];
}

export interface ThrowExpression {
  readonly start: number;
  readonly end: number;
  /** Simple type name as written, e.g. `IOException`. Empty when unparseable. */
  readonly typeName: string;
}

const IDENT = "[A-Za-z_$][\\w$.]*";

/**
 * Replace comments and string/char literals with spaces, preserving length and
 * therefore every offset in the original text.
 */
export function stripNonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === "/" && next === "/") {
      let j = i + 2;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        // An unterminated single/double-quoted literal should not swallow the file.
        if (quote !== "`" && text[j] === "\n") break;
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the `}` matching the `{` at `openIndex`, or -1. */
export function matchBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Next non-whitespace index at or after `from`. */
function skipSpace(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return i;
}

/**
 * Parse the `catch (...) { }` clauses (and `finally`) that follow a try body.
 * Stops at the first token that is neither.
 */
function parseCatches(code: string, afterBody: number): CatchClause[] {
  const out: CatchClause[] = [];
  let i = skipSpace(code, afterBody);

  for (;;) {
    if (code.startsWith("catch", i)) {
      const parenOpen = code.indexOf("(", i);
      const braceOpen = code.indexOf("{", i);
      if (parenOpen === -1 || braceOpen === -1) break;

      const parenClose = code.indexOf(")", parenOpen);
      const header =
        parenClose === -1 ? "" : code.slice(parenOpen + 1, parenClose);
      const bodyEnd = matchBrace(code, braceOpen);
      if (bodyEnd === -1) break;

      out.push({
        start: i,
        end: bodyEnd + 1,
        typeNames: typeNamesFrom(header),
      });
      i = skipSpace(code, bodyEnd + 1);
    } else if (code.startsWith("finally", i)) {
      const braceOpen = code.indexOf("{", i);
      const bodyEnd = braceOpen === -1 ? -1 : matchBrace(code, braceOpen);
      if (bodyEnd === -1) break;
      i = skipSpace(code, bodyEnd + 1);
    } else {
      break;
    }
  }
  return out;
}

/**
 * Extract type names from a catch header.
 *
 * Handles Java/C#-style `IOException e`, multi-catch `A | B e`, and bare
 * `catch {}` / `catch (e)` where no type is named.
 */
export function typeNamesFrom(header: string): string[] {
  const trimmed = header.trim();
  if (trimmed === "") return [];

  // Drop a trailing parameter name: `IOException e` -> `IOException`.
  const parts = trimmed.split("|");
  return parts
    .map((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return "";
      // In multi-catch (`A | B e`) only the last part carries the parameter
      // name, so every part is a type. With a single part, a lone token is a
      // binding name (`catch (e)`) rather than a type.
      return parts.length > 1 || tokens.length >= 2 ? tokens[0]! : "";
    })
    .filter((t) => t !== "" && new RegExp(`^${IDENT}$`).test(t));
}

/**
 * All `try` blocks whose **body** contains `offset`, innermost first.
 *
 * Only the body counts: an exception thrown inside a `catch` or `finally` is
 * not handled by that same `try`, which is exactly the rule a naive scanner
 * would get wrong.
 */
export function findEnclosingTryBlocks(
  code: string,
  offset: number,
): TryBlock[] {
  const out: TryBlock[] = [];
  const re = /\btry\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    const braceOpen = code.indexOf("{", m.index);
    if (braceOpen === -1) continue;
    // Only `try {` or a try-with-resources header `try (...) {` counts. Checking
    // the parens as a balanced pair rather than stripping them with a regex,
    // since resource headers routinely contain nested calls: `try (var r = open())`.
    const between = code.slice(m.index + 3, braceOpen).trim();
    if (between !== "" && !(between.startsWith("(") && between.endsWith(")")))
      continue;

    const bodyEnd = matchBrace(code, braceOpen);
    if (bodyEnd === -1) continue;

    if (offset > braceOpen && offset < bodyEnd) {
      out.push({
        start: m.index,
        bodyStart: braceOpen + 1,
        bodyEnd,
        catches: parseCatches(code, bodyEnd + 1),
      });
    }
  }
  // Innermost first: the smallest enclosing body wins.
  return out.sort((a, b) => b.bodyStart - a.bodyStart);
}

/** The `throw`/`raise` statement containing `offset`, if any. */
export function findThrowAt(
  code: string,
  offset: number,
): ThrowExpression | undefined {
  const re = /\b(?:throw|raise)\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    let end = code.indexOf(";", m.index);
    const newline = code.indexOf("\n", m.index);
    if (end === -1 || (newline !== -1 && newline < end)) end = newline;
    if (end === -1) end = code.length;

    if (offset >= m.index && offset <= end) {
      const body = code.slice(m.index, end);
      const withNew = new RegExp(`\\bnew\\s+(${IDENT})`).exec(body);
      const bare = new RegExp(`\\b(?:throw|raise)\\s+(${IDENT})`).exec(body);
      const name = withNew?.[1] ?? bare?.[1] ?? "";
      return { start: m.index, end, typeName: name };
    }
  }
  return undefined;
}

/**
 * Approximate enclosing function: the innermost brace block whose header looks
 * like a signature (`name(...)` before the `{`).
 *
 * Approximate is the honest word — without a grammar this cannot distinguish a
 * method from an `if`. It is only used to place the `escapes-function` marker,
 * and the core's caller-walk relies on LSP Call Hierarchy rather than this.
 */
export function findEnclosingFunction(
  code: string,
  offset: number,
): { start: number; end: number } | undefined {
  let best: { start: number; end: number } | undefined;

  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "{") continue;
    const end = matchBrace(code, i);
    if (end === -1 || offset <= i || offset >= end) continue;

    const header = code.slice(Math.max(0, i - 200), i);
    if (
      !new RegExp(`${IDENT}\\s*\\([^)]*\\)\\s*(?:\\w[\\w\\s,.<>]*)?$`).test(
        header.trim(),
      )
    ) {
      continue;
    }
    if (!best || i > best.start) best = { start: i, end };
  }
  return best;
}

/**
 * Does a catch of `caughtName` plausibly handle `thrownName`?
 *
 * Compares simple names only — there is no type hierarchy here, so a
 * `catch (Exception)` cannot be proven to handle an `IOException`. The
 * well-known root types are the one pragmatic exception, because treating them
 * as non-matching would hide the most common real handler.
 */
const CATCH_ALL = new Set([
  "Exception",
  "Throwable",
  "Error",
  "RuntimeException",
  "BaseException",
  "object",
]);

export function handlerMatches(
  thrownName: string,
  caughtName: string,
): boolean {
  if (caughtName === "" || thrownName === "") return true; // untyped catch
  const thrown = simpleName(thrownName);
  const caught = simpleName(caughtName);
  return thrown === caught || CATCH_ALL.has(caught);
}

export function simpleName(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(i + 1);
}
