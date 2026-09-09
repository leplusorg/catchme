---
layout: base.njk
permalink: /docs/
title: Documentation
description: How to install and use CatchMe — the commands, the settings, how to read a result, and what to do when it does not behave.
---

{#
markdownlint counts a front matter `title:` as the document's h1 and then
reports the real heading below as a second one (MD025). It is not: base.njk
renders `title` into `<title>` and og:title only, never into the page body,
so `# Documentation` is the only h1 this page has. Clearing the pattern says
"front matter titles are not headings here" rather than switching MD025 off,
so a genuine second `#` would still be caught. Note the closing delimiter:
a `#}` alone at column 1 is read as an ATX heading by markdownlint. #}

<!-- markdownlint-configure-file { "MD025": { "front_matter_title": "" } } -->

<section>
<div class="wrap-wide">

# Documentation

Everything needed to install CatchMe and read what it tells you. The commands
and settings tables below are generated from the extension manifest at build
time, so they cannot drift from what ships.

## Install

From inside Visual Studio Code, open the Extensions view and search for **CatchMe**, or run
this from the Command Palette (<kbd>Ctrl/Cmd</kbd>+<kbd>P</kbd>):

```text
ext install {{ extension.id }}
```

It is also on the [Visual Studio Code Marketplace]({{ site.marketplace }}) and
[Open VSX]({{ site.openvsx }}) for VSCodium, Gitpod and Cursor. Requires Visual Studio Code
`{{ extension.vscodeVersion }}` or later.

### Language support

| Language                    | You also need                                                                                                                 | Answers are |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Java                        | [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java), in **Standard** mode | `definite`  |
| Other brace-style languages | The language's own extension, if it implements LSP Call Hierarchy                                                             | `possible`  |

Red Hat's Java extension is deliberately _not_ a hard dependency — CatchMe
installs and works for other languages without it.

## Using it

### Trace a real throw

1. Put the cursor on a `throw` statement.
2. Right-click and choose **Find Where This Is Caught**.
3. Results appear in the **Exception Flow** view in the activity bar, and a Peek
   opens at the first handler.

The menu item only appears when the cursor is actually on a throw. If you cannot
see it, that is why.

### Simulate a throw that isn't there

1. Put the cursor anywhere — no `throw` required.
2. Right-click and choose **Simulate Exception From Here…**.
3. Pick a type from the list, or type a fully-qualified name.

Useful for "if this call started throwing `IllegalStateException`, who would
notice?" without editing any code.

## Reading a result

Results group by **destination** — where the exception can end up — with the
call chain that reaches each one nested underneath:

<div class="tree"><span class="t-exc">▾ 🔥 IOException</span>                       <span class="t-dim">2 destinations · 3 paths</span>
  <span class="t-ok">▾ ✓ catch (IOException e)</span>              <span class="t-dim">Service.java:88 · definite</span>
      <span class="t-exc">🔥 throw new IOException(…)</span>            <span class="t-dim">Repo.java:42</span>
      <span class="t-dim">↑</span>  Repo.load()                <span class="t-dim">called at Service.java:71</span>
      <span class="t-ok">✓</span>  catch (IOException e)         <span class="t-dim">Service.java:88</span>
  <span class="t-dim">▸ ~ catch (Exception e)</span>                 <span class="t-dim">Api.java:23 · possible</span>
  <span class="t-dim">▸ ⛔ uncaught — no caller found</span>          <span class="t-note">1 path</span>
</div>

| Marker | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| 🔥     | The throw site the chain starts from                            |
| ↑      | A frame the exception escaped, showing where it was called from |
| ✓      | A handler that catches it                                       |
| ~      | Same, but only `possible` — see below                           |
| ⛔     | Nothing catches it; it leaves the program or thread             |
| ⋯      | The search stopped at the depth limit — click to expand further |

Clicking a hop jumps to its **call site**, not its declaration: that is the line
where the exception actually leaves for the next frame.

### definite vs. possible

Static analysis cannot be exact where there is virtual dispatch, reflection or
dynamic typing, so every result says how much it is worth:

- **`definite`** — proven against a real type hierarchy.
- **`possible`** — approximate, or the language offers no type information.

Two rules follow, and they point in opposite directions on purpose:

- A **chain** is rated by its _weakest_ hop. One approximate step makes the whole
  route `possible`, even when the final type match is exact.
- A **destination** is rated by its _best_ route, because reachability asks
  whether _any_ chain gets there.

A backend without real type information can never report `definite` — the core
enforces that regardless of what a provider claims.

### Chains that converge, and frames you don't care about

Several call chains reaching one handler collapse into a single destination.
Consecutive frames outside your workspace fold into one `… N library frames`
node. Set `catchme.analysis.includeLibraryCode` to follow into dependencies.

## Commands

{#
Raw HTML rather than a markdown table, here and under Settings, because a
Nunjucks loop cannot live inside one. GFM reads every line between the
delimiter row and the next blank line as a table row, so `{% for %}` and
`{% endfor %}` were each parsed as a one-cell row and rendered as an empty
`<tr>` — the built page had a blank row before every command. markdownlint
flagged exactly those lines (MD056, "too few cells"); it was pointing at a
real defect, not at template syntax it failed to understand. #}

<table>
  <thead>
    <tr><th>Command</th><th>Where</th></tr>
  </thead>
  <tbody>
  {%- for c in extension.commands %}
    <tr><td>{{ c.title }}</td><td>{{ c.where }}</td></tr>
  {%- endfor %}
  </tbody>
</table>

All are available from the Command Palette as well.

## Settings

<table>
  <thead>
    <tr><th>Setting</th><th>Default</th><th>Meaning</th></tr>
  </thead>
  <tbody>
  {%- for s in extension.settings %}
    <tr><td><code>{{ s.id }}</code></td><td><code>{{ s.default }}</code></td><td>{{ s.description | mdInline | safe }}</td></tr>
  {%- endfor %}
  </tbody>
</table>

## Troubleshooting

**"Find Where This Is Caught" is not in the menu.**
It only shows when the cursor is inside a `throw`. Use **Simulate Exception From
Here…** anywhere else.

**Java results say the backend is unavailable.**
CatchMe needs Red Hat's Java extension running in **Standard** mode — LightWeight
mode has no resolved type bindings, and answering without them would produce
confidently wrong results, so it refuses instead. Check the status bar and wait
for indexing to finish.

**Results stop at "depth limit reached".**
The search is bounded so a cyclic call graph cannot hang the editor. Click
**expand further** to continue, or raise `catchme.analysis.maxDepth`.

**A handler you expected is missing.**
Where several chains converge on the same call site, only the first continues
through it — results are representative routes, not every possible route. That
bound is what keeps recursive graphs finite.

**Everything is `possible` and nothing is `definite`.**
Expected for any language other than Java: without a type hierarchy, a handler
match cannot be proven. See [definite vs. possible](#definite-vs-possible).

## Something else?

Please [open an issue]({{ site.newIssue }}) — there are templates for bug
reports, feature requests and questions.

</div>
</section>
