/**
 * Java provider — the deep-backend reference implementation.
 *
 * All real analysis happens inside jdt.ls (headless Eclipse JDT), where there
 * is a genuine AST with resolved type bindings. This file is the marshalling
 * layer: it forwards requests over the `redhat.java` executeCommand bridge and
 * maps the JSON back onto the CatchMe model.
 *
 * That mapping is not ceremony. The server can only send plain JSON, but the
 * core navigates results with `vscode.Uri`/`Location` *instances* — handing it
 * raw objects would fail the moment the user clicks a result.
 *
 * The Java side lives in `server-java/` and registers an
 * `org.eclipse.jdt.ls.core.delegateCommandHandler` for the command ids below.
 */
import * as vscode from "vscode";
import {
  ProviderNotReadyError,
  type ExceptionFlowProvider,
  type ExceptionTypeRef,
  type FlowProgress,
  type FlowRequest,
  type FlowResult,
  type PropagationPath,
  type ProviderCapabilities,
  type Sink,
  type ThrowSite,
} from "@leplusorg/catchme-api";

/** Command ids implemented by the bundled jdt.ls extension (server-java/). */
const CMD = {
  resolveThrowSite: "catchme.java.resolveThrowSite",
  suggestExceptionTypes: "catchme.java.suggestExceptionTypes",
  analyzeFlow: "catchme.java.analyzeFlow",
} as const;

/** redhat.java's generic bridge for invoking jdt.ls workspace commands. */
const JAVA_EXECUTE_WORKSPACE_COMMAND = "java.execute.workspaceCommand";
const JAVA_EXTENSION_ID = "redhat.java";

// ---------------------------------------------------------------------------
// Wire format — mirrors org.leplus.catchme.jdt.Json on the server
// ---------------------------------------------------------------------------

interface RawPosition {
  line: number;
  character: number;
}
interface RawRange {
  start: RawPosition;
  end: RawPosition;
}
interface RawLocation {
  uri: string;
  range: RawRange;
}
interface RawSink {
  kind: Sink["kind"];
  location: RawLocation;
  label: string;
  confidence: Sink["confidence"];
  reason?: string;
  /** Where an escaping frame was invoked from; makes the chain navigable. */
  callSite?: RawLocation;
}
interface RawThrowSite {
  uri: string;
  range: RawRange | null;
  exceptionType: ExceptionTypeRef;
  simulated: boolean;
}
interface RawFlowResult {
  throwSite?: RawThrowSite;
  paths?: { steps: RawSink[]; depth: number; truncated?: boolean }[];
  terminals?: RawSink[];
  partial?: boolean;
  diagnostics?: string[];
}

const EMPTY_RANGE: RawRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function toRange(raw: RawRange | null | undefined): vscode.Range {
  const r = raw ?? EMPTY_RANGE;
  return new vscode.Range(
    r.start.line,
    r.start.character,
    r.end.line,
    r.end.character,
  );
}

function toLocation(raw: RawLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(raw.uri), toRange(raw.range));
}

function toSink(raw: RawSink): Sink {
  return {
    kind: raw.kind,
    location: toLocation(raw.location),
    label: raw.label,
    confidence: raw.confidence,
    ...(raw.reason ? { reason: raw.reason } : {}),
    ...(raw.callSite ? { callSite: toLocation(raw.callSite) } : {}),
  };
}

function toThrowSite(raw: RawThrowSite): ThrowSite {
  return {
    uri: vscode.Uri.parse(raw.uri),
    range: toRange(raw.range),
    exceptionType: raw.exceptionType,
    simulated: raw.simulated,
  };
}

/**
 * @param fallback used when the server could not echo a throw site back — the
 *        core relies on `result.throwSite` being present to render the tree.
 */
function toFlowResult(
  raw: RawFlowResult | undefined,
  fallback: ThrowSite,
): FlowResult {
  const paths: PropagationPath[] = (raw?.paths ?? []).map((p) => ({
    steps: (p.steps ?? []).map(toSink),
    depth: p.depth ?? 0,
    ...(p.truncated === true ? { truncated: true } : {}),
  }));
  return {
    throwSite: raw?.throwSite ? toThrowSite(raw.throwSite) : fallback,
    paths,
    terminals: (raw?.terminals ?? []).map(toSink),
    partial: raw?.partial === true,
    ...(raw?.diagnostics?.length ? { diagnostics: raw.diagnostics } : {}),
  };
}

// ---------------------------------------------------------------------------

export class JavaProvider implements ExceptionFlowProvider {
  readonly languages = ["java"] as const;

  readonly capabilities: ProviderCapabilities = {
    intraprocedural: true,
    interprocedural: true, // JDT's search engine is walked server-side
    typeHierarchy: true, // real ITypeBinding subtype matching
    simulate: true,
    precision: "definite",
    engine: "JDT (jdt.ls)",
  };

  /**
   * jdt.ls must be running in **Standard** mode; LightWeight mode has no
   * resolved bindings and would silently produce confidently wrong answers.
   */
  private async ensureReady(): Promise<void> {
    const ext = vscode.extensions.getExtension(JAVA_EXTENSION_ID);
    if (!ext) {
      throw new ProviderNotReadyError(
        "The Java language support extension is not installed.",
        'Install "Language Support for Java(TM) by Red Hat" to analyse Java files.',
      );
    }
    const api = ext.isActive ? ext.exports : await ext.activate();
    if (typeof api?.serverReady === "function") {
      await api.serverReady();
    }
    if (api?.serverMode && api.serverMode !== "Standard") {
      throw new ProviderNotReadyError(
        "The Java language server is running in LightWeight mode.",
        "Full type resolution is required; open a Java project and wait for Standard mode.",
      );
    }
  }

  private async invoke<T>(command: string, payload: unknown): Promise<T> {
    await this.ensureReady();
    return (await vscode.commands.executeCommand<T>(
      JAVA_EXECUTE_WORKSPACE_COMMAND,
      command,
      payload,
    )) as T;
  }

  async resolveThrowSite(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<ThrowSite | undefined> {
    const raw = await this.invoke<RawThrowSite | null>(CMD.resolveThrowSite, {
      uri: document.uri.toString(),
      position: { line: position.line, character: position.character },
    });
    // null is meaningful: the caret is not on a throw, which hides the menu item.
    return raw ? toThrowSite(raw) : undefined;
  }

  async suggestExceptionTypes(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<readonly ExceptionTypeRef[]> {
    const raw = await this.invoke<ExceptionTypeRef[] | null>(
      CMD.suggestExceptionTypes,
      {
        uri: document.uri.toString(),
        position: { line: position.line, character: position.character },
      },
    );
    return raw ?? [];
  }

  async analyzeExceptionFlow(
    request: FlowRequest,
    _progress: FlowProgress,
    _token: vscode.CancellationToken,
  ): Promise<FlowResult> {
    const { throwSite, options } = request;
    const raw = await this.invoke<RawFlowResult | undefined>(CMD.analyzeFlow, {
      uri: throwSite.uri.toString(),
      range: {
        start: {
          line: throwSite.range.start.line,
          character: throwSite.range.start.character,
        },
        end: {
          line: throwSite.range.end.line,
          character: throwSite.range.end.character,
        },
      },
      exceptionTypeId: throwSite.exceptionType.id,
      simulated: throwSite.simulated,
      options,
    });
    return toFlowResult(raw, throwSite);
  }
}
