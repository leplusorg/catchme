package org.leplus.catchme.jdt;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IMethod;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.CatchClause;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.IMethodBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.Initializer;
import org.eclipse.jdt.core.dom.LambdaExpression;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.NodeFinder;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.ThrowStatement;
import org.eclipse.jdt.core.dom.TryStatement;
import org.eclipse.jdt.core.dom.Type;
import org.eclipse.jdt.core.dom.UnionType;
import org.eclipse.jdt.core.search.IJavaSearchConstants;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.core.search.SearchMatch;
import org.eclipse.jdt.core.search.SearchParticipant;
import org.eclipse.jdt.core.search.SearchPattern;
import org.eclipse.jdt.core.search.SearchRequestor;

/**
 * Resolves where an exception thrown at a given site can be handled.
 *
 * <p>Two phases, matching the design's two tiers:
 *
 * <ol>
 *   <li><b>Intraprocedural</b> — walk enclosing {@code try} statements from the
 *       throw site. Precise: only a try's body and its resources are protected
 *       (a throw inside a {@code catch}/{@code finally} is <em>not</em> caught
 *       by that same try), union multi-catch is expanded, and matching uses real
 *       {@link ITypeBinding#isSubTypeCompatible} subtype checks.
 *   <li><b>Interprocedural</b> — when the exception escapes, find the enclosing
 *       method's callers with {@link SearchEngine} and repeat phase 1 seeded at
 *       each call site, breadth-first, until a handler, the depth cap, or the
 *       time budget.
 * </ol>
 *
 * <p>Results reached through more than zero hops are labelled {@code possible}
 * rather than {@code definite}: a reference search cannot prove which override
 * actually runs at a virtual call site.
 */
public final class ExceptionFlowAnalyzer {

    private final IProgressMonitor monitor;
    private final int maxDepth;
    private final long deadlineMillis;
    private final boolean includeLibraryCode;

    private boolean partial;

    public ExceptionFlowAnalyzer(IProgressMonitor monitor, Map<String, Object> options) {
        this.monitor = monitor;
        this.maxDepth = intOption(options, "maxDepth", 8);
        this.includeLibraryCode = Boolean.TRUE.equals(options.get("includeLibraryCode"));
        this.deadlineMillis = System.currentTimeMillis() + intOption(options, "timeoutMs", 15_000);
    }

    // ------------------------------------------------------------------ entry

    /**
     * Locate the throw statement at {@code (line, character)}.
     *
     * @return a JSON-ready ThrowSite map, or {@code null} when the position is
     *         not inside a throw. Returning null is meaningful: it drives the
     *         context key that shows or hides the menu item.
     */
    public Map<String, Object> resolveThrowSite(ICompilationUnit unit, int line, int character) {
        CompilationUnit root = parse(unit);
        ASTNode node = nodeAt(root, line, character);
        ThrowStatement stmt = enclosingThrow(node);
        if (stmt == null) {
            return null;
        }
        ITypeBinding thrown = stmt.getExpression() == null
                ? null
                : stmt.getExpression().resolveTypeBinding();
        if (thrown == null) {
            return null;
        }
        return Json.throwSite(unit, Json.range(root, stmt), Json.exceptionType(thrown), false);
    }

    /** Analyse propagation of {@code thrownType} from the given position. */
    public Map<String, Object> analyze(
            ICompilationUnit unit, int line, int character, ITypeBinding thrownType,
            Map<String, Object> throwSiteJson) {

        CompilationUnit root = parse(unit);
        ASTNode origin = nodeAt(root, line, character);
        ThrowStatement stmt = enclosingThrow(origin);
        ASTNode seed = stmt != null ? stmt : origin;

        List<Object> paths = new ArrayList<>();
        List<Object> terminals = new ArrayList<>();
        List<String> diagnostics = new ArrayList<>();

        // Breadth-first over frames. Each entry carries the steps taken so far.
        Deque<Frame> queue = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        queue.add(new Frame(unit, root, seed, 0, new ArrayList<>()));

        while (!queue.isEmpty()) {
            if (outOfBudget()) {
                // Everything still queued stopped short of a real terminal;
                // keep it flagged so the UI can offer to expand rather than
                // silently losing the chain.
                partial = true;
                for (Frame pending : queue) {
                    if (!pending.steps.isEmpty()) {
                        paths.add(Json.path(new ArrayList<>(pending.steps), pending.depth, true));
                    }
                }
                break;
            }
            Frame frame = queue.poll();
            Map<String, Object> sink = resolveWithinMethod(frame, thrownType);

            if (sink == null) {
                // No enclosing method at all (rare: malformed source).
                continue;
            }
            List<Object> steps = new ArrayList<>(frame.steps);
            steps.add(sink);

            if (!"escapes-function".equals(sink.get("kind"))) {
                paths.add(Json.path(steps, frame.depth));
                terminals.add(sink);
                continue;
            }

            if (frame.depth >= maxDepth) {
                partial = true;
                paths.add(Json.path(steps, frame.depth, true));
                continue;
            }

            MethodDeclaration method = enclosingMethod(frame.node);
            List<CallSite> callers = method == null
                    ? List.of()
                    : findCallers(method, diagnostics);

            if (callers.isEmpty()) {
                // Nothing calls it: an entry point, or framework-invoked.
                Map<String, Object> uncaught = Json.sink(
                        "uncaught", sink.get("location"),
                        "No caller found — propagates out of the program or thread",
                        "possible", "no references reported by the search engine");
                steps.add(uncaught);
                paths.add(Json.path(steps, frame.depth));
                terminals.add(uncaught);
                continue;
            }

            for (CallSite caller : callers) {
                if (!visited.add(caller.key())) {
                    continue;
                }
                CompilationUnit callerRoot = parse(caller.unit);
                ASTNode callNode = NodeFinder.perform(callerRoot, caller.offset, caller.length);
                if (callNode == null) {
                    continue;
                }
                // Attribute the call site to the frame it escaped, per branch:
                // the same method reached from three callers yields three
                // distinct chains, each with its own call site.
                List<Object> viaCaller = withCallSite(
                        steps, Json.location(caller.unit, Json.range(callerRoot, callNode)));
                queue.add(new Frame(caller.unit, callerRoot, callNode, frame.depth + 1, viaCaller));
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("throwSite", throwSiteJson);
        result.put("paths", paths);
        result.put("terminals", terminals);
        result.put("partial", partial);
        if (!diagnostics.isEmpty()) {
            result.put("diagnostics", diagnostics);
        }
        return result;
    }

    // -------------------------------------------------------- intraprocedural

    /**
     * Walk outward from {@code frame.node} to the first matching handler, or to
     * the method boundary.
     */
    private Map<String, Object> resolveWithinMethod(Frame frame, ITypeBinding thrown) {
        ASTNode current = frame.node;
        ASTNode parent = current.getParent();
        boolean approximate = frame.depth > 0;

        while (parent != null) {
            if (parent instanceof TryStatement) {
                TryStatement tryStmt = (TryStatement) parent;
                if (isProtectedRegion(current, tryStmt)) {
                    CatchClause match = firstMatchingCatch(tryStmt, thrown);
                    if (match != null) {
                        SingleVariableDeclaration ex = match.getException();
                        return Json.sink(
                                "caught",
                                Json.location(frame.unit, Json.range(frame.root, match)),
                                "catch (" + ex.getType() + " " + ex.getName().getIdentifier() + ")",
                                approximate ? "possible" : "definite",
                                approximate ? "reached through a call site; the actual override may differ" : null);
                    }
                }
                // Came out of a catch or finally: this try cannot handle it.
            } else if (parent instanceof MethodDeclaration
                    || parent instanceof LambdaExpression
                    || parent instanceof Initializer) {
                return Json.sink(
                        "escapes-function",
                        Json.location(frame.unit, Json.range(frame.root, parent)),
                        "escapes " + describeBoundary(parent),
                        approximate ? "possible" : "definite",
                        isChecked(thrown) ? "checked exception" : "unchecked exception");
            }
            current = parent;
            parent = current.getParent();
        }
        return null;
    }

    /**
     * Copy of {@code steps} whose last entry records the call site it escaped
     * through. Copied rather than mutated because sibling branches share the
     * prefix.
     */
    @SuppressWarnings("unchecked")
    private static List<Object> withCallSite(List<Object> steps, Map<String, Object> callSite) {
        List<Object> copy = new ArrayList<>(steps);
        if (copy.isEmpty()) {
            return copy;
        }
        Object last = copy.remove(copy.size() - 1);
        if (last instanceof Map) {
            Map<String, Object> annotated = new LinkedHashMap<>((Map<String, Object>) last);
            annotated.put("callSite", callSite);
            copy.add(annotated);
        } else {
            copy.add(last);
        }
        return copy;
    }

    /** Only the try body and try-with-resources resources are protected. */
    private boolean isProtectedRegion(ASTNode ascendedFrom, TryStatement tryStmt) {
        if (ascendedFrom == tryStmt.getBody()) {
            return true;
        }
        for (Object resource : tryStmt.resources()) {
            if (ascendedFrom == resource) {
                return true;
            }
        }
        return false;
    }

    private CatchClause firstMatchingCatch(TryStatement tryStmt, ITypeBinding thrown) {
        for (Object o : tryStmt.catchClauses()) {
            CatchClause clause = (CatchClause) o;
            Type caught = clause.getException().getType();
            if (caught instanceof UnionType) {
                for (Object part : ((UnionType) caught).types()) {
                    if (catches(thrown, ((Type) part).resolveBinding())) {
                        return clause;
                    }
                }
            } else if (catches(thrown, caught.resolveBinding())) {
                return clause;
            }
        }
        return null;
    }

    /** A {@code catch (C)} handles thrown type T iff T is C or a subtype of C. */
    private boolean catches(ITypeBinding thrown, ITypeBinding caught) {
        return thrown != null && caught != null && thrown.isSubTypeCompatible(caught);
    }

    // -------------------------------------------------------- interprocedural

    private List<CallSite> findCallers(MethodDeclaration method, List<String> diagnostics) {
        IMethodBinding binding = method.resolveBinding();
        if (binding == null) {
            return List.of();
        }
        IJavaElement element = binding.getJavaElement();
        if (!(element instanceof IMethod)) {
            return List.of();
        }
        List<CallSite> out = new ArrayList<>();
        try {
            SearchPattern pattern = SearchPattern.createPattern(
                    (IMethod) element, IJavaSearchConstants.REFERENCES);
            if (pattern == null) {
                return List.of();
            }
            SearchRequestor requestor = new SearchRequestor() {
                @Override
                public void acceptSearchMatch(SearchMatch match) {
                    Object owner = match.getElement();
                    if (!(owner instanceof IJavaElement)) {
                        return;
                    }
                    ICompilationUnit callerUnit =
                            (ICompilationUnit) ((IJavaElement) owner)
                                    .getAncestor(IJavaElement.COMPILATION_UNIT);
                    if (callerUnit == null) {
                        return; // binary/library caller with no source
                    }
                    out.add(new CallSite(callerUnit, match.getOffset(), match.getLength()));
                }
            };
            new SearchEngine().search(
                    pattern,
                    new SearchParticipant[] { SearchEngine.getDefaultSearchParticipant() },
                    includeLibraryCode
                            ? SearchEngine.createWorkspaceScope()
                            : SearchEngine.createJavaSearchScope(new IJavaElement[] {
                                    ((IMethod) element).getJavaProject() }),
                    requestor,
                    monitor);
        } catch (Exception e) {
            diagnostics.add("Caller search failed for "
                    + binding.getName() + ": " + e.getMessage());
        }
        return out;
    }

    // ---------------------------------------------------------------- helpers

    private CompilationUnit parse(ICompilationUnit unit) {
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setKind(ASTParser.K_COMPILATION_UNIT);
        parser.setSource(unit);
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        return (CompilationUnit) parser.createAST(monitor);
    }

    private ASTNode nodeAt(CompilationUnit root, int line, int character) {
        // LSP positions are 0-based; CompilationUnit#getPosition takes 1-based lines.
        int offset = root.getPosition(line + 1, character);
        if (offset < 0) {
            offset = root.getPosition(line + 1, 0);
        }
        ASTNode node = NodeFinder.perform(root, Math.max(offset, 0), 0);
        return node != null ? node : root;
    }

    private static ThrowStatement enclosingThrow(ASTNode node) {
        while (node != null && !(node instanceof ThrowStatement)) {
            node = node.getParent();
        }
        return (ThrowStatement) node;
    }

    private static MethodDeclaration enclosingMethod(ASTNode node) {
        while (node != null && !(node instanceof MethodDeclaration)) {
            node = node.getParent();
        }
        return (MethodDeclaration) node;
    }

    private static String describeBoundary(ASTNode boundary) {
        if (boundary instanceof MethodDeclaration) {
            return "method '" + ((MethodDeclaration) boundary).getName().getIdentifier() + "'";
        }
        if (boundary instanceof LambdaExpression) {
            return "a lambda expression";
        }
        return "an initializer";
    }

    /** Checked = neither a RuntimeException nor an Error. */
    static boolean isChecked(ITypeBinding thrown) {
        for (ITypeBinding t = thrown; t != null; t = t.getSuperclass()) {
            String qn = t.getQualifiedName();
            if ("java.lang.RuntimeException".equals(qn) || "java.lang.Error".equals(qn)) {
                return false;
            }
        }
        return true;
    }

    private boolean outOfBudget() {
        return (monitor != null && monitor.isCanceled())
                || System.currentTimeMillis() > deadlineMillis;
    }

    private static int intOption(Map<String, Object> options, String key, int fallback) {
        Object v = options == null ? null : options.get(key);
        return v instanceof Number ? ((Number) v).intValue() : fallback;
    }

    // ------------------------------------------------------------ value types

    /** One frame of the breadth-first walk. */
    private static final class Frame {
        final ICompilationUnit unit;
        final CompilationUnit root;
        final ASTNode node;
        final int depth;
        final List<Object> steps;

        Frame(ICompilationUnit unit, CompilationUnit root, ASTNode node, int depth, List<Object> steps) {
            this.unit = unit;
            this.root = root;
            this.node = node;
            this.depth = depth;
            this.steps = steps;
        }
    }

    private static final class CallSite {
        final ICompilationUnit unit;
        final int offset;
        final int length;

        CallSite(ICompilationUnit unit, int offset, int length) {
            this.unit = unit;
            this.offset = offset;
            this.length = length;
        }

        String key() {
            return unit.getHandleIdentifier() + "#" + offset;
        }
    }
}
