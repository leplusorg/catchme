package fixtures;

import java.io.IOException;

/**
 * Interprocedural fixture: the exception escapes {@code deep()}, travels through
 * {@code middle()}, and is handled in {@code top()}.
 *
 * <p>Unlike {@link BasicHandlers}, every method here is genuinely called from
 * within this file, so a reference search has a real chain to follow. That is
 * what exercises the call-site recording and the hop-by-hop rendering.
 */
public class Propagation {

    /** Nothing here handles it, so it leaves the method. */
    void deep() throws IOException {
        throw new IOException("boom");    // @throws java.io.IOException
                                          // @escapes
    }

    /** A pass-through frame: no try, so it escapes again. */
    void middle() throws IOException {
        deep();
    }

    /** The handler, two hops from the throw. */
    void top() {
        try {
            middle();
        } catch (IOException e) {         // @caught possible
            // handles it
        }
    }
}
