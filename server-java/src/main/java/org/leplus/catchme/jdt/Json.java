package org.leplus.catchme.jdt;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/**
 * Builders for the JSON shapes the TypeScript side expects.
 *
 * <p>Every key here mirrors a field in {@code @leplusorg/catchme-api}; changing one without the
 * other silently breaks the bridge, so keep them in step. Positions are LSP-style: <b>0-based</b>
 * lines and characters.
 */
final class Json {

  /** Static builders only. */
  private Json() {}

  /**
   * The URI the client uses for {@code unit}.
   *
   * @param unit a compilation unit.
   * @return its URI, in the form jdt.ls reports to the client.
   */
  @SuppressWarnings("restriction") // JDTUtils is jdt.ls-internal; no public equivalent
  static String uri(ICompilationUnit unit) {
    return JDTUtils.toURI(unit);
  }

  /**
   * {@code { line, character }} — 0-based, converted from JDT's 1-based lines.
   *
   * @param root the AST whose line table resolves {@code offset}.
   * @param offset a character offset into {@code root}'s source.
   * @return a JSON-ready LSP Position map.
   */
  static Map<String, Object> position(CompilationUnit root, int offset) {
    Map<String, Object> out = new LinkedHashMap<>();
    int line = root.getLineNumber(offset);
    int column = root.getColumnNumber(offset);
    out.put("line", Math.max(line - 1, 0));
    out.put("character", Math.max(column, 0));
    return out;
  }

  /**
   * {@code { start, end }} covering {@code node}.
   *
   * @param root the AST {@code node} belongs to.
   * @param node the node to cover.
   * @return a JSON-ready LSP Range map.
   */
  static Map<String, Object> range(CompilationUnit root, ASTNode node) {
    int start = node.getStartPosition();
    int end = start + Math.max(node.getLength(), 0);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("start", position(root, start));
    out.put("end", position(root, end));
    return out;
  }

  /**
   * {@code { uri, range }}.
   *
   * @param unit the compilation unit the range is in.
   * @param range a Range map, as built by {@link #range}.
   * @return a JSON-ready LSP Location map.
   */
  static Map<String, Object> location(ICompilationUnit unit, Map<String, Object> range) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("uri", uri(unit));
    out.put("range", range);
    return out;
  }

  /**
   * {@code ExceptionTypeRef}. {@code id} is the fully-qualified name used for matching.
   *
   * @param binding the exception type to describe.
   * @return a JSON-ready ExceptionTypeRef map.
   */
  static Map<String, Object> exceptionType(ITypeBinding binding) {
    Map<String, Object> out = new LinkedHashMap<>();
    String qualified = binding.getQualifiedName();
    out.put("id", qualified == null || qualified.isEmpty() ? binding.getName() : qualified);
    out.put("label", binding.getName());
    out.put("kind", classify(binding));
    return out;
  }

  /**
   * The {@code kind} of an ExceptionTypeRef.
   *
   * @param binding the exception type to classify.
   * @return {@code error}, {@code unchecked} or {@code checked}.
   */
  private static String classify(ITypeBinding binding) {
    for (ITypeBinding t = binding; t != null; t = t.getSuperclass()) {
      String qn = t.getQualifiedName();
      if ("java.lang.Error".equals(qn)) {
        return "error";
      }
      if ("java.lang.RuntimeException".equals(qn)) {
        return "unchecked";
      }
    }
    return ExceptionFlowAnalyzer.isChecked(binding) ? "checked" : "unknown";
  }

  /**
   * {@code ThrowSite}: where the exception starts.
   *
   * @param unit the compilation unit containing the site.
   * @param range the site's Range map; null for a simulated throw with no selection.
   * @param exceptionType an ExceptionTypeRef map, as built by {@link #exceptionType}.
   * @param simulated true when the user chose the type rather than pointing at a throw.
   * @return a JSON-ready ThrowSite map.
   */
  static Map<String, Object> throwSite(
      ICompilationUnit unit,
      Map<String, Object> range,
      Map<String, Object> exceptionType,
      boolean simulated) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("uri", uri(unit));
    out.put("range", range);
    out.put("exceptionType", exceptionType);
    out.put("simulated", simulated);
    return out;
  }

  /**
   * {@code Sink}: one step of a propagation path.
   *
   * @param kind {@code caught}, {@code escapes-function} or {@code uncaught}.
   * @param location a Location map, as built by {@link #location}.
   * @param label the text shown for the step.
   * @param confidence {@code definite} or {@code possible}.
   * @param reason why the confidence is what it is; omitted from the JSON when null.
   * @return a JSON-ready Sink map.
   */
  static Map<String, Object> sink(
      String kind, Object location, String label, String confidence, String reason) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("kind", kind);
    out.put("location", location);
    out.put("label", label);
    out.put("confidence", confidence);
    if (reason != null) {
      out.put("reason", reason);
    }
    return out;
  }

  /**
   * A propagation path that reached a real terminal.
   *
   * @param steps the sinks visited, in order from the throw site outward.
   * @param depth how many call-site hops the path crossed.
   * @return a JSON-ready Path map.
   */
  static Map<String, Object> path(List<Object> steps, int depth) {
    return path(steps, depth, false);
  }

  /**
   * A propagation path, optionally flagged as cut short.
   *
   * @param steps the sinks visited, in order from the throw site outward.
   * @param depth how many call-site hops the path crossed.
   * @param truncated true when a bound stopped the walk, not a real terminal.
   * @return a JSON-ready Path map.
   */
  static Map<String, Object> path(List<Object> steps, int depth, boolean truncated) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("steps", steps);
    out.put("depth", depth);
    if (truncated) {
      out.put("truncated", Boolean.TRUE);
    }
    return out;
  }
}
