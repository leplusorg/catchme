package fixtures;

import java.io.IOException;

/**
 * Conformance fixture: intraprocedural handler resolution.
 *
 * <p>Annotations are consumed by @leplusorg/catchme-provider-testkit: // @throws <typeId> marks the
 * throw site to analyse // @caught [definite|possible] the expected handler // @escapes expected to
 * leave the method // @uncaught expected to reach a top-level boundary
 */
public class BasicHandlers {

  /** Supertype match: IOException is caught by `catch (Exception)`. */
  void caughtBySupertype() {
    try {
      throw new IOException("boom"); // @throws java.io.IOException
    } catch (IllegalStateException e) {
      // not a match
    } catch (Exception e) { // @caught definite
      // handles it
    }
  }

  /** Nested try: the innermost matching catch wins. */
  void innermostWins() {
    try {
      try {
        throw new IllegalArgumentException(); // @throws java.lang.IllegalArgumentException
      } catch (RuntimeException e) { // @caught definite
        // inner handler
      }
    } catch (Throwable t) {
      // must NOT be reported
    }
  }

  /** Multi-catch: the union member matches. */
  void multiCatch() {
    try {
      throw new IOException(); // @throws java.io.IOException
    } catch (IllegalStateException | IOException e) { // @caught definite
      // handles it
    }
  }

  /** A throw inside a catch is NOT caught by that same try's other clauses. */
  void rethrowFromCatch() {
    try {
      throw new IOException();
    } catch (IOException e) {
      throw new IllegalStateException(e); // @throws java.lang.IllegalStateException
      // @escapes
    }
  }

  /** try-with-resources: close() can throw and is inside the protected region. */
  void tryWithResources() throws IOException {
    try (AutoCloseableStub r = new AutoCloseableStub()) {
      r.use(); // @throws java.io.IOException
    } catch (IOException e) { // @caught definite
      // handles it
    }
  }

  /** No enclosing handler: propagates to callers. */
  void escapesToCallers() throws IOException {
    throw new IOException("propagates"); // @throws java.io.IOException
    // @escapes
  }

  static final class AutoCloseableStub implements AutoCloseable {
    void use() throws IOException {}

    @Override
    public void close() throws IOException {}
  }
}
