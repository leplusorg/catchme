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

  private Json() {}

  static String uri(ICompilationUnit unit) {
    return JDTUtils.toURI(unit);
  }

  /** `{ line, character }` — 0-based, converted from JDT's 1-based lines. */
  static Map<String, Object> position(CompilationUnit root, int offset) {
    Map<String, Object> out = new LinkedHashMap<>();
    int line = root.getLineNumber(offset);
    int column = root.getColumnNumber(offset);
    out.put("line", Math.max(line - 1, 0));
    out.put("character", Math.max(column, 0));
    return out;
  }

  static Map<String, Object> range(CompilationUnit root, ASTNode node) {
    int start = node.getStartPosition();
    int end = start + Math.max(node.getLength(), 0);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("start", position(root, start));
    out.put("end", position(root, end));
    return out;
  }

  static Map<String, Object> location(ICompilationUnit unit, Map<String, Object> range) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("uri", uri(unit));
    out.put("range", range);
    return out;
  }

  /** `ExceptionTypeRef`. `id` is the fully-qualified name used for matching. */
  static Map<String, Object> exceptionType(ITypeBinding binding) {
    Map<String, Object> out = new LinkedHashMap<>();
    String qualified = binding.getQualifiedName();
    out.put("id", qualified == null || qualified.isEmpty() ? binding.getName() : qualified);
    out.put("label", binding.getName());
    out.put("kind", classify(binding));
    return out;
  }

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

  static Map<String, Object> path(List<Object> steps, int depth) {
    return path(steps, depth, false);
  }

  /**
   * @param truncated true when a bound stopped the walk, not a real terminal.
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
