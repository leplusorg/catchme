# `server/` — bundled jdt.ls extension

This directory holds the **built** Java analyzer jar that `redhat.java` loads
into jdt.ls. It is referenced by `contributes.javaExtensions` in
`packages/core/package.json`.

The jar is a **build artifact** — it is produced from `server-java/` and is not
checked in:

```sh
pnpm run build:server   # mvn -f server-java/pom.xml verify
pnpm run copy:server    # copies the jar here
```

Until you run those, the Java provider will report that its backend is
unavailable; every other language still works through the generic LSP provider.
