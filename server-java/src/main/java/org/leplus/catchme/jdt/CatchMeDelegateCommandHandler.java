package org.leplus.catchme.jdt;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.IType;
import org.eclipse.jdt.core.ITypeHierarchy;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.IBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/**
 * Entry point for every CatchMe command invoked from the VS Code extension.
 *
 * <p>jdt.ls calls this on a worker thread with the JSON payload sent by
 * {@code java.execute.workspaceCommand}. Everything returned must be plain
 * JSON-serialisable data matching the model in {@code @leplusorg/catchme-api} —
 * see {@link Json}.
 *
 * <p>The analysis itself lives in {@link ExceptionFlowAnalyzer}; this class only
 * unpacks payloads and resolves Java model handles.
 */
public class CatchMeDelegateCommandHandler implements IDelegateCommandHandler {

    static final String RESOLVE_THROW_SITE = "catchme.java.resolveThrowSite";
    static final String SUGGEST_TYPES = "catchme.java.suggestExceptionTypes";
    static final String ANALYZE_FLOW = "catchme.java.analyzeFlow";

    /** Cap on Quick Pick suggestions; a project's Throwable hierarchy is large. */
    private static final int MAX_SUGGESTIONS = 200;

    @Override
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor)
            throws Exception {
        Map<String, Object> payload = firstMap(arguments);

        switch (commandId) {
            case RESOLVE_THROW_SITE:
                return resolveThrowSite(payload, monitor);
            case SUGGEST_TYPES:
                return suggestExceptionTypes(payload, monitor);
            case ANALYZE_FLOW:
                return analyzeFlow(payload, monitor);
            default:
                throw new UnsupportedOperationException("Unknown command: " + commandId);
        }
    }

    // ------------------------------------------------------------- commands

    private Object resolveThrowSite(Map<String, Object> payload, IProgressMonitor monitor) {
        ICompilationUnit unit = unit(payload);
        if (unit == null) {
            return null;
        }
        Map<String, Object> position = map(payload.get("position"));
        return new ExceptionFlowAnalyzer(monitor, Map.of())
                .resolveThrowSite(unit, intAt(position, "line"), intAt(position, "character"));
    }

    /**
     * Candidate exception types for the Quick Pick, most relevant first:
     * types already imported by the file, then the project's Throwable
     * hierarchy. Ordering matters more than completeness — the user can always
     * type a fully-qualified name instead.
     */
    private Object suggestExceptionTypes(Map<String, Object> payload, IProgressMonitor monitor)
            throws Exception {
        ICompilationUnit unit = unit(payload);
        if (unit == null) {
            return List.of();
        }
        IJavaProject project = unit.getJavaProject();
        IType throwable = project.findType("java.lang.Throwable");
        if (throwable == null) {
            return List.of();
        }

        Set<String> seen = new LinkedHashSet<>();
        List<Object> out = new ArrayList<>();

        // 1. Types the file already imports — nearly always what the user wants.
        for (IJavaElement child : unit.getChildren()) {
            if (child instanceof org.eclipse.jdt.core.IImportDeclaration) {
                String name = child.getElementName();
                IType imported = project.findType(name);
                if (imported != null && isThrowable(imported, throwable, monitor) && seen.add(name)) {
                    out.add(typeRef(imported));
                }
            }
        }

        // 2. Everything else in the project's Throwable hierarchy.
        ITypeHierarchy hierarchy = throwable.newTypeHierarchy(project, monitor);
        for (IType candidate : hierarchy.getAllSubtypes(throwable)) {
            if (out.size() >= MAX_SUGGESTIONS) {
                break;
            }
            String fqn = candidate.getFullyQualifiedName();
            if (seen.add(fqn)) {
                out.add(typeRef(candidate));
            }
        }
        return out;
    }

    private Object analyzeFlow(Map<String, Object> payload, IProgressMonitor monitor)
            throws Exception {
        ICompilationUnit unit = unit(payload);
        if (unit == null) {
            return empty("No compilation unit for the requested URI.");
        }

        Map<String, Object> range = map(payload.get("range"));
        Map<String, Object> start = map(range.get("start"));
        int line = intAt(start, "line");
        int character = intAt(start, "character");

        String typeId = string(payload.get("exceptionTypeId"));
        ITypeBinding thrown = resolveTypeBinding(unit.getJavaProject(), typeId, monitor);
        if (thrown == null) {
            return empty("Could not resolve exception type '" + typeId + "' on the classpath.");
        }

        boolean simulated = Boolean.TRUE.equals(payload.get("simulated"));
        Map<String, Object> options = map(payload.get("options"));

        ExceptionFlowAnalyzer analyzer = new ExceptionFlowAnalyzer(monitor, options);

        // For a real throw the site is whatever is under the cursor; for a
        // simulated one we synthesise it from the chosen type.
        Map<String, Object> throwSite = simulated ? null : analyzer.resolveThrowSite(unit, line, character);
        if (throwSite == null) {
            throwSite = Json.throwSite(
                    unit,
                    range.isEmpty() ? null : range,
                    Json.exceptionType(thrown),
                    simulated);
        }
        return analyzer.analyze(unit, line, character, thrown, throwSite);
    }

    // -------------------------------------------------------------- helpers

    private static boolean isThrowable(IType type, IType throwable, IProgressMonitor monitor) {
        try {
            ITypeHierarchy h = type.newSupertypeHierarchy(monitor);
            for (IType sup : h.getAllSupertypes(type)) {
                if (throwable.getFullyQualifiedName().equals(sup.getFullyQualifiedName())) {
                    return true;
                }
            }
            return throwable.getFullyQualifiedName().equals(type.getFullyQualifiedName());
        } catch (Exception e) {
            return false;
        }
    }

    private static Map<String, Object> typeRef(IType type) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", type.getFullyQualifiedName());
        out.put("label", type.getElementName());
        out.put("kind", "unknown"); // refined client-side; cheap to leave open
        return out;
    }

    private static ITypeBinding resolveTypeBinding(
            IJavaProject project, String fqn, IProgressMonitor monitor) throws Exception {
        if (project == null || fqn == null) {
            return null;
        }
        IType type = project.findType(fqn);
        if (type == null) {
            return null;
        }
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setProject(project);
        IBinding[] bindings = parser.createBindings(new IJavaElement[] { type }, monitor);
        return bindings.length == 1 && bindings[0] instanceof ITypeBinding
                ? (ITypeBinding) bindings[0]
                : null;
    }

    private static ICompilationUnit unit(Map<String, Object> payload) {
        String uri = string(payload.get("uri"));
        return uri == null ? null : JDTUtils.resolveCompilationUnit(uri);
    }

    private static Map<String, Object> empty(String diagnostic) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("paths", List.of());
        out.put("terminals", List.of());
        out.put("partial", Boolean.FALSE);
        out.put("diagnostics", List.of(diagnostic));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstMap(List<Object> arguments) {
        return arguments == null || arguments.isEmpty()
                ? Map.of()
                : (Map<String, Object>) arguments.get(0);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : Map.of();
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static int intAt(Map<String, Object> map, String key) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).intValue() : 0;
    }
}
