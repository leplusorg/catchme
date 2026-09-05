/**
 * Minimal stand-in for the `vscode` module.
 *
 * provider-java imports `vscode` at runtime (unlike the other packages, which
 * only need its types), so unit tests alias the module to this file — see
 * vitest.config.ts. Only the surface the provider actually touches is stubbed.
 *
 * The Position/Range/Uri/Location classes matter: the provider's job is to turn
 * server JSON into real instances, so stubbing them as classes is what lets the
 * tests prove the mapping happened rather than passing plain objects through.
 */

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
  }
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

export interface StubExtension {
  id: string;
  isActive: boolean;
  exports: unknown;
  activate: () => Promise<unknown>;
}

/** Mutable state so each test can arrange the environment it needs. */
export const __stub: {
  extension: StubExtension | undefined;
  calls: Array<{ command: string; args: unknown[] }>;
  result: unknown;
} = {
  extension: undefined,
  calls: [],
  result: undefined,
};

export function __reset(): void {
  __stub.extension = undefined;
  __stub.calls = [];
  __stub.result = undefined;
}

export const extensions = {
  getExtension: (_id: string): StubExtension | undefined => __stub.extension,
};

export const commands = {
  executeCommand: async (
    command: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    __stub.calls.push({ command, args });
    return __stub.result;
  },
};
