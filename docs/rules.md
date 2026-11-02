# The rules language

Rules live in two kinds of files with the same language (`.ste`):

- **Global rules**, opened with **Semantic Theme Extender: Open Rules**. Saving applies them
  immediately, and they sync across machines with Settings Sync (UI State).
- **Project rules** in a workspace folder's `.vscode/semantic-theme.ste`, see
  [Project rules](#project-rules).

The editor shows color swatches for every value as computed for the current theme, hover help
for keywords and theme colors, completion for token types, UI colors, functions and extension
IDs, and errors as you type. `;` starts a comment.

- [Rules](#rules)
- [Selectors](#selectors)
- [Conditions](#conditions)
- [Custom modifiers](#custom-modifiers)
- [Messages](#messages)
- [Values](#values)
- [Matching themes](#matching-themes)
- [Project rules](#project-rules)

## Rules

```ini
struct = #86C691                     ; fills a gap: skipped where the theme colors struct itself
override enum = style(class, bold)   ; also replaces the theme's own color
override {
  namespace = soften(variable)
}
```

A rule is `head = value`. It is skipped where the theme has a rule for exactly that selector, so
your rules fill what the theme leaves. "Exactly" means a theme rule for `struct` blocks your
`struct` rule, but not `recordStruct`; a theme rule for `string` doesn't block
`string.quoted.docstring.python`. A more specific rule of yours is a deliberate refinement.

`override` rules, alone or as a block, also replace the theme's own colors. Later rules override
earlier ones.

A **block** `head { rules }` applies its head to every rule inside: the block's head and each
rule's head must all hold, e.g. `language(python) { … }`, `contains(…) & !text("_*") { … }`.

`$none` as a value means no rule for this selector, e.g. to drop a rule for some themes.

## Selectors

| Selector | Meaning |
| --- | --- |
| `struct`, `parameter:python`, `*.static` | Semantic selector: a token type, optionally with modifiers or a language. Also sets the TextMate scope VS Code falls back to (`struct` → `entity.name.type.struct`), so the color shows before the language server is ready |
| `string.quoted.docstring.python` | TextMate scope: any other name with a dot. Sets only the TextMate color |
| `editorBracketHighlight.foreground1` | UI color: any color ID VS Code or an installed extension knows. Takes a color, not `style()` |

Names are recognized in that order: token type, then UI color ID, then TextMate scope. To say
the kind explicitly, write `semantic`, `textmate` or `ui` before a name, or before a block:

```ini
textmate comment = #6A9955          ; only the TextMate scope 'comment'
semantic struct  = #86C691          ; only the semantic rule, no TextMate fallback
override ui {
  editor.background = darken(ui editor.background, 5%)
}
```

The name must fit the kind. `semantic` writes only the semantic rule, without the TextMate
fallback; `textmate` takes the name literally as a scope. It combines with `override`, and also
works in values: `ui editor.background`.

The modifiers a token can have come from its language server. Inspect Token lists them; besides
the standard ones (`declaration`, `readonly`, `static`, `deprecated`, `async`, …), Pylance adds
for example `classMember`, `builtin` and `library`, rust-analyzer `public`, `mutable`, `unsafe`
and `trait`.

### Selector expressions

A head is a selector expression: selectors and [conditions](#conditions) side by side mean
*and* (also written `&`), plus `|`, `!` and parentheses.

```ini
struct | enum = …
variable *.readonly = …
language(python) selfParameter = …
contains(text("__slots__") variable.classMember) & !text("_*") class = …
```

Where an expression boils down to plain selectors, they go to settings as usual (`struct` and
`enum`; `variable.readonly`; `selfParameter:python`), with gap filling and TextMate fallback.
Everything else (`text`, `contains`, `!`, two different types, …) is **drawn** as editor
decorations over the language server's semantic tokens instead. Drawn rules always win over the
theme and appear shortly after the language server has analyzed the file. Where several match a
token, the most specific wins, the way VS Code ranks semantic rules: a token type over `*`, more
modifiers, a language, then an exact text over a wildcard; file order only between equals.

### Named expressions

```ini
@slots => contains(text("__slots__") variable.classMember)
@slots class = …
inherits(@slots) class = …
```

`@name => expression` names an expression for use in any head: `@slots class`,
`inherits(@slots) class`, `@slots & !contains(…) class`, or alone, `@slots = …`. Top level only,
assigned once, usable before its declaration.

## Conditions

Conditions look at more than a token's type: its text, the document's language and language
server, and what the language server knows about the symbol. All but `language` and `server`
make a rule drawn.

### language, server

```ini
language(python) selfParameter = …
language(python, csharp) { … }
server(ms-python.vscode-pylance) { … }
```

`language(ids)` holds in documents of these languages.

`server(extension IDs)` holds in documents that extension serves: it's active and starts for
their language, or brings the language itself (rust-analyzer starts on `Cargo.toml` and
contributes `rust`). Rules are really about a language server more than a language: Pylance
makes `__slots__` a `variable.classMember`, basedpyright a `property.classMember`. Completion
lists the installed extensions, Inspect Token shows a token's candidates, and an ID that isn't
installed gets a hint. VS Code doesn't say which extension answered, so two active servers for
one language both match. Always drawn.

Both are decided once per document, so rules for other languages cost nothing there.

### text

```ini
text("__slots__") variable.classMember = …
text("__*__", "_*") * = …
```

Only tokens with one of these texts. Takes [patterns](#patterns).

### contains

```ini
contains(text("__slots__") variable.classMember) class = …
contains(text("__enter__") method | text("__aenter__") method) class = …
```

Only tokens naming a symbol (class, function, …) that directly contains a match: here classes
that define `__slots__`. Matches at their declaration and wherever they're used, also in other
workspace files (the use is looked up with go to definition, a moment after the rest is drawn).
The inside is a selector expression too. Uses the language server's document symbols.

### within

```ini
within(class text("Ctx")) method = …
```

Only tokens inside a symbol whose name token matches: here methods of a class named `Ctx`. Same
file, from document symbols.

### decorated

```ini
decorated(text("dataclass")) class = …
decorated(text("Obsolete", "ObsoleteAttribute")) = …
```

Only tokens naming a symbol with a matching decorator or attribute: Python `@dataclass`, C#
`[Serializable]`, Rust `#[derive(Debug)]`, Java annotations, TypeScript decorators. Counts the
tokens before the symbol's name, in its range or on the lines right above starting with `@`, `[`
or `#[`. Matches at the declaration and wherever it's used, also in other files, like
`contains`.

- C# attribute names are `class` tokens and may be written with or without `Attribute`.
- C# reports `[Obsolete]` members as `namespace.deprecated`, not `method`: leave the type out
  there, or use `*.deprecated`.

### inherits

```ini
inherits(text("Exception")) class = …
inherits(contains(text("__slots__") variable.classMember)) class = …
```

Only tokens naming a type with a base type, directly or further up, whose name token matches:
here subclasses of classes that define `__slots__`, also when the base lives in another file or a
library. Uses the language server's type hierarchy, so it appears a little later. Pylance and
the C# extension provide one; TypeScript and rust-analyzer don't.

The name token is the base type's declaration, with what the language server says about it
there. Pylance marks builtins as `builtin` in `builtins.pyi` too, so
`inherits(text("tuple") & class.builtin) class` means subclasses of the real `tuple`, not of
any class named `tuple`.

### doc, signature

```ini
doc("*deprecated*") function = …
signature("*: Callable*") variable = …
```

`doc` matches a token's documentation: the prose of its hover (Python docstrings, C# `///`
summaries, JSDoc, Rust `///`), without code blocks, so not the signature. `signature` matches
those code blocks: the signature or type. Both take [patterns](#patterns), any case for globs,
and several patterns mean any. They work for names defined anywhere, libraries included. Hovers
are asked for once per name, and only for tokens the rest of the rule lets through, a moment
after the rest is drawn.

Signatures are written differently per language: Pylance writes `(variable) handler:
Callable[[int], str]` or `(function) def f(a: int) -> str`, C# `int Foo.Bar(string s)`. So
patterns are per language; `*: int` and `*-> None` avoid matching `Point` or `-> Optional[int]`.

Rust's hovers start with the module path (`core::fmt::macros`) and C#'s name the namespace
(`System.Func<…>`), so `signature("core::*")` or `signature("*System.Collections.*")` match by
where a name comes from.

### from

```ini
from("typing") = …
from("*/site-packages/numpy/*") class = …
from("*/node_modules/react/*") function = …
```

Only tokens defined in a matching file, as go to definition finds it: for names from a module,
library or package whose hovers don't say where they come from, as in Python and TypeScript. A
glob without `/` names the file, with or without its extensions: `"typing"` matches `typing.py`
and typeshed's `typing.pyi`, `"lib.es5"` matches `lib.es5.d.ts`. A glob with `/`, or a regular
expression, matches the whole path, written with `/`. Globs ignore case.

Definitions are asked for once per name, only for tokens the rest of the rule lets through; a
name declared in the same file is defined there without asking. So
`inherits(from("builtins")) class` means subclasses of Python's builtin types.

C# leads to a decompiled file named after the type, which doesn't say its namespace or assembly;
use `signature` there.

### Unsupported conditions

Some conditions need more from the language server than tokens: `inherits` a type hierarchy,
`contains`, `within` and `decorated` document symbols, `doc` and `signature` hovers. When a
language's server turns out not to have it (no type hierarchy at a class declaration, as with
TypeScript), the condition gets a warning in the rules file and the Problems panel, e.g.
*inherits() can't match in typescript*, and Inspect Token says so on that language's tokens.

Only where the rule can apply: `language(python) { inherits(…) … }` isn't warned about for
TypeScript. It's learned from the files you open, so it shows once a file of that language has
been open.

rust-analyzer sometimes has no symbols for a file opened while it starts, until the file's first
edit; `contains`, `decorated` and `within` match nothing there until then.

### Patterns

Wherever a pattern is taken (`text`, `doc`, `signature`, `from`, `theme`, `match($theme)`), it is
either:

- a quoted glob, where `*` matches anything and the whole text must match: `"*Light*"`. In
  `text` it is case-sensitive; for a language that isn't, use `/^name$/i`. `doc`, `signature`,
  `from` and theme names ignore case.
- a regular expression literal, for advanced cases: `/^Dark/i`, `signature(/: int\b/)`,
  `text(/^_[a-z]/)`. It's found anywhere unless anchored with `^` / `$`, and takes its flags as
  written (`i` for any case). Invalid ones are reported as you type.

Both can be mixed in one list.

## Custom modifiers

```ini
contains(text("__slots__") variable.classMember) class += slotted
inherits(class.slotted) & !class.slotted += leaky

class.slotted = style(class, bold)
class.leaky   = style(function, bold | italic)
```

`head += name` gives tokens the head matches a modifier, as if the language server had reported
it, and any rule can select it: `class.slotted = …`, `inherits(class.slotted) class`, also in
another rules file. Assignments run in order, global rules first, then the project's.

The name is written bare, like a token type, not as `"slotted"` or a `$variable`: it is the same
name rules select it by, and a selector like `class.slotted` can't hold a variable either.

A name used in one file and defined in another workspace file gets the custom modifiers of its
definition (asked of the language server's go to definition), a moment after the rest is drawn.

Modifiers no language server defines count as custom ones, except as plain names after `string`,
`comment`, `keyword` or `variable`, which stay TextMate scopes (`variable.foo`): there write
`*.foo`, `semantic variable.foo`, or use it in an expression. Rules with custom modifiers are
drawn. One that nothing in the same file assigns gets a hint, in case it's a typo.

## Messages

```ini
inherits(class.slotted) & !class.slotted & class.declaration := warn("{text} gets a __dict__ again")
text("print") function := hint(debug-output, "left-over print")
```

`head := level("text")` puts a message on every token the head matches, in open files: `error`,
`warn`, `info` or `hint` (faint dots, not in the Problems panel). `{text}` is the token's text.
Unlike colors, every matching message shows. Limit it to definitions with `.declaration`.

`warn(name, "text")` names a message: the name shows in the Problems panel and silences it in
code. A comment containing `semantic-theme: ignore` on the token's line, or alone on the line
above, silences every message there; `semantic-theme: ignore leaky-slots` only that one (several
names: spaces or commas). Any comment syntax works. The lightbulb offers **Ignore … here**, which
adds the comment line above, for languages with line comments it knows.

## Values

```ini
$structLike = #86C691
struct        = offset(class, #4EC9B0, #86C691, light)
typeParameter = mix(class, function, 0.5)
selfParameter:python = variable.language
editorBracketHighlight.foreground1 = soften(keyword, 15%)
```

| Value | Meaning |
| --- | --- |
| `#86C691`, `rgb(134, 198, 145)` | A literal color. `rgb` takes integers 0-255, decimals 0.0-1.0 (`rgb(0.5, 1.0, 0.2)`) or percentages, plus an optional alpha |
| `class`, `function` | The active theme's color for that semantic selector |
| `variable.language` | The active theme's color for that TextMate scope |
| `editor.background` | The active theme's UI color, or VS Code's default where the theme doesn't set it |
| `$name` | A variable: `$name = value`, top level only, assigned once, usable before its definition |
| `offset(c, base, target, light)` | Apply the change from `base` to `target` to `c`: lightness (as a share of the room toward white or black), chroma ratio, and a hue shift of the same visible size (so a muted color shifts by a larger angle). Exact where `c` equals `base`. Where the optional condition holds (`light`, `light & !contrast`, …), the lightness direction flips: for references measured on a dark theme, pass `light` |
| `emphasize(c, 10%)`, `soften(c, 10%)` | More / less contrast to the editor background: lighter on dark themes, darker on light ones |
| `lighten(c, 10%)`, `darken` | Change lightness (OKLCH, 0-1) by an absolute amount: 10% adds or subtracts 0.1 |
| `saturate(c, 20%)`, `desaturate` | Scale chroma relatively: 20% means x 1.2 or x 0.8 |
| `hue(c, 30)`, `hue(c, 5%)` | Rotate the hue: by degrees (`30deg` and `30°` also work), or by a visible distance. The same angle changes muted colors much less than saturated ones; a percentage looks equally different on any color |
| `mix(a, b, 0.5)`, `alpha(c, 50%)` | Blend two colors, set opacity |
| `style(c, bold \| !italic)` | Font styles; `style(underline)` keeps the theme's color. TextMate has a single font style per rule, so there the flags replace the whole style |
| `$none` | No rule for this selector |

Numbers keep their unit: `10%` is the same as `0.1` wherever an amount is expected, and a unit
that doesn't fit (`lighten(c, 10deg)`, `alpha(c, 30deg)`) is an error.

Bracket pair colorization uses `editorBracketHighlight.foreground1` to `foreground6`. VS Code's
defaults for 4 to 6 are transparent, which means "not used": brackets cycle through the first
three levels unless you set more.

## Matching themes

```ini
theme("Dark Modern", "Dark 2026") {
  struct = #86C691
}
theme("*Light*") interface = $none
dark & contrast {
  enum = style(emphasize(class, 20%), bold)
}

$accent = match($type) {
  dark & contrast -> emphasize(class, 20%)
  _               -> emphasize(class)
}
```

Rules for some themes only have a theme condition in their head, like `language(python)` for
some languages:

- `theme("Dark Modern", "*Light*")`: the active theme's name, as [patterns](#patterns), any case.
- `dark`, `light`, `contrast`: the theme's type. A high-contrast dark theme is `dark & contrast`.

They combine with everything else in a head, `theme("*Light*") & language(python) { … }`, and
are decided once when the rules are applied, so plain selectors still go to settings. A head
needs a selector besides them: `dark struct = …`, not `dark = …`. Rules for other themes are
still checked as you type.

`match` picks a value by the active theme. Arms are tried top to bottom and the first match
wins; `_` matches anything.

| Subject | Patterns |
| --- | --- |
| `$type` | Flags `dark`, `light`, `contrast`, combined with `&` (and), `\|` (or), `!` (not) and parentheses |
| `$theme` | Theme names as [patterns](#patterns): `"Dark Modern" \| "*Light*"` |

`dark` and `light` are decided once, by the actual brightness of the theme's editor background,
and mean the same everywhere: in heads, in `match($type)`, in `offset` conditions and in
`emphasize` / `soften`. `contrast` comes from the theme's declared type. Impossible or
unreachable arms, and matches that don't cover every theme type, are flagged as you type.

## Project rules

What only makes sense for one codebase goes in `.vscode/semantic-theme.ste` in that workspace
folder (**Open Project Rules** creates it), and can be committed with the project. It says what
tokens are, as custom modifiers; your global rules say how that looks, the same in every project
and with your own `$variables`:

```ini
; .vscode/semantic-theme.ste
language(python) {
  contains(text("__slots__") variable.classMember) class += slotted
  inherits(class.slotted) & !class.slotted += leaky
}

; global rules
class.slotted = style(struct, bold)
class.leaky = style(function, bold | italic)
```

The project file applies on save, after the global rules, to files in that folder only, in
trusted workspaces. Color rules there still work, with a warning: they are drawn as decorations
(settings are shared by all windows), so semantic selectors only, and they can't use the global
rules' variables.

Its custom modifiers also reach library files the project's files lead to, outside the
workspace, so a project can say what a library's types are:

```ini
language(python) {
  text("tuple") & class.builtin += tuple
  class.slotted | class.tuple += struct
  inherits(class.struct) & !class.slotted += leaky
}
```

`inherits` looks at `tuple` where `builtins.pyi` declares it, which is a struct here too. In a
library file only the names asked about get custom modifiers: a `contains` or `within` there
sees the file without them.
