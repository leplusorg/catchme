/**
 * Minimal stand-in for the `vscode` module, aliased in vitest.config.ts.
 *
 * The provider builds real `Range`/`Location` instances for the core to
 * navigate, so these are classes rather than plain objects — that is what lets
 * the tests assert the mapping actually happened.
 */

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class Uri {
  private constructor(readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  toString(): string {
    return this.value;
  }
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range,
  ) {}
}

/** A fake TextDocument backed by a plain string. */
export function makeDocument(text: string, uri = "file:///T.java"): unknown {
  const lineStarts = (): number[] => {
    const starts = [0];
    for (let i = 0; i < text.length; i++)
      if (text[i] === "\n") starts.push(i + 1);
    return starts;
  };
  return {
    uri: Uri.parse(uri),
    getText: () => text,
    offsetAt: (p: Position) => (lineStarts()[p.line] ?? 0) + p.character,
    positionAt: (offset: number) => {
      const starts = lineStarts();
      let line = 0;
      for (let i = 0; i < starts.length; i++)
        if (starts[i]! <= offset) line = i;
      return new Position(line, offset - starts[line]!);
    },
  };
}

export const __stub: { documents: Map<string, unknown> } = {
  documents: new Map(),
};

export function __reset(): void {
  __stub.documents.clear();
}

export const workspace = {
  openTextDocument: async (uri: Uri | string): Promise<unknown> => {
    const key = typeof uri === "string" ? uri : uri.toString();
    const doc = __stub.documents.get(key);
    if (!doc) throw new Error(`no stub document registered for ${key}`);
    return doc;
  },
};
