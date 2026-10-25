# Semantic Theme Extender

Most VS Code themes color every type the same: classes, structs, interfaces, enums and
type parameters all end up one color, even though language servers like C# Dev Kit and
Pylance tell VS Code exactly which is which.

Semantic Theme Extender fills that gap for **whatever theme you use**. It derives the
missing colors from the theme's own palette, so they fit in, and leaves everything the
theme already defines alone.

## Rules

Run **Semantic Theme Extender: Open Rules** to edit your rules. Saving applies them
immediately, and they sync across machines with Settings Sync (UI State).

```ini
; variables: top level, assigned once, usable before their definition
$structLike = #86C691
$accent = match($type) {
  dark & contrast -> emphasize(class, 20%)
  _               -> emphasize(class)
}

; rules fill what the theme leaves: skipped where the theme colors the token itself
; offset: Visual Studio's class -> struct change, applied to this theme's class color
struct        = offset(class, #4EC9B0, #86C691, light)
interface     = offset(class, #4EC9B0, #B8D7A3, light)
typeParameter = mix(class, function, 0.5)
selfParameter:python = variable.language

; override also replaces the theme's own colors: one rule, or a block
override enum = style($accent, bold | !italic)
override {
  namespace = soften(variable)
}

; a block of rules for matching themes
match($theme) {
  "Dark Modern" | "Dark 2026" {
    struct = $structLike
  }
  "*Light*" {
    interface = $none
  }
}

; UI colors: bracket pair colors that follow the theme's own palette
editorBracketHighlight.foreground1 = soften(keyword, 15%)
editorBracketHighlight.foreground2 = soften(function, 15%)
editorBracketHighlight.foreground3 = soften(type, 15%)

; say the kind explicitly where it matters
textmate comment = #6A9955          ; only the TextMate scope 'comment'
semantic struct  = #86C691          ; only the semantic rule, no TextMate fallback
override ui {
  editor.background = darken(ui editor.background, 5%)
}
```

| Syntax | Meaning |
| --- | --- |
| `selector = value` | Rule; skipped where the theme has a rule for exactly that selector. Later rules override earlier ones |
| `override selector = value`, `override { rules }` | Rules that also replace the theme's own colors |
| `struct`, `parameter:python`, `*.static` | Semantic selector: a token type, optionally with known modifiers or a language. Also sets the TextMate scope VS Code falls back to (`struct` → `entity.name.type.struct`), so the color shows before the language server is ready |
| `string.quoted.docstring.python` | TextMate scope: any other name with a dot. Sets only the TextMate color |
| `editorBracketHighlight.foreground1` | UI color: any color ID VS Code or an installed extension knows. Takes a color, not `style()` |
| `struct \| enum`, `variable *.readonly`, `language(python) selfParameter` | A rule's left side is a selector expression: side by side means *and*, plus `\|`, `!` and parentheses. Where it boils down to plain selectors, they go to settings (`struct` and `enum`; `variable.readonly`; `selfParameter:python`) with gap filling and TextMate fallback as usual. `language(python, csharp)` is a list |
| `text("__slots__") variable.classMember`, `text("__*__", "_*") *` | Only tokens with one of these texts (`*` wildcards) |
| `contains(text("__slots__") variable.classMember) class` | Only tokens naming a symbol (class, function, …) that directly contains a match: classes that define `__slots__`, at their declaration and uses in the same file. Uses the language server's document symbols. The inside is a selector expression too: `contains(text("__enter__") method \| text("__aenter__") method)` |
| `within(class text("Ctx")) method` | Only tokens inside a symbol whose name token matches: here methods of a class named `Ctx`. Same file, from document symbols |
| `inherits(contains(text("__slots__") variable.classMember)) class` | Only tokens naming a type with a base type, directly or further up, whose name token matches: here subclasses of classes that define `__slots__`, also when the base lives in another file or a library. Uses the language server's type hierarchy (Pylance, C# and TypeScript provide it), so it appears a little later |
| `@slots => contains(text("__slots__") variable.classMember)` | A named selector expression, used as `@slots` in any head: `@slots class = …`, `inherits(@slots) class`, `@slots & !contains(…) class`, or alone: `@slots = …`. Top level only, assigned once, usable before its declaration |
| `head { rules }` | A block: its head and each rule's head must all hold, e.g. `language(python) { … }`, `contains(…) & !text("_*") { … }` |
| Decorations | Heads that aren't plain selectors (`text`, `contains`, `!`, two different types, …) are drawn as editor decorations over the language server's semantic tokens instead of written to settings. They always win over the theme and appear shortly after the language server has analyzed the file. Where several match a token, the most specific wins, like VS Code ranks semantic rules: a token type over `*`, more modifiers, a language, then an exact text over a wildcard; file order only between equals |
| `ui name`, `semantic name`, `textmate name`, `ui { rules }` | Say what kind of name it is instead of inferring it (token type, then UI color ID, then TextMate scope). The name must fit the kind. `semantic` writes only the semantic rule, without the TextMate fallback; `textmate` takes the name literally as a scope. Combines with `override`, also in values: `ui editor.background` |
| `class`, `function` (as a value) | The active theme's color for that semantic selector |
| `variable.language` (as a value) | The active theme's color for that TextMate scope |
| `editor.background` (as a value) | The active theme's UI color, or VS Code's default where the theme doesn't set it |
| `$name = color` | Variable: top level only, assigned once |
| `#86C691`, `rgb(134, 198, 145)` | A literal color. `rgb` takes integers 0-255, decimals 0.0-1.0 (`rgb(0.5, 1.0, 0.2)`) or percentages, plus an optional alpha |
| `offset(c, base, target, light)` | Apply the change from `base` to `target` to `c`: lightness (as a share of the room toward white or black), chroma ratio, and a hue shift of the same visible size (so a muted color shifts by a larger angle). Exact where `c` equals `base`. Where the optional condition holds (`light`, `light & !contrast`, ...), the lightness direction flips: for references measured on a dark theme, pass `light` |
| `emphasize(c, 10%)`, `soften(c, 10%)` | More / less contrast to the editor background: lighter on dark themes, darker on light ones |
| `lighten(c, 10%)`, `darken` | Change lightness (OKLCH, 0-1) by an absolute amount: 10% adds or subtracts 0.1 |
| `saturate(c, 20%)`, `desaturate` | Scale chroma relatively: 20% means x 1.2 or x 0.8 |
| `hue(c, 30)`, `hue(c, 5%)` | Rotate the hue: by degrees (`30deg` and `30°` also work), or by a visible distance. The same angle changes muted colors much less than saturated ones; a percentage looks equally different on any color |
| `mix(a, b, 0.5)`, `alpha(c, 50%)` | Blend two colors, set opacity |
| `style(c, bold \| !italic)` | Font styles; `style(underline)` keeps the theme's color |
| `$none` | No rule for this selector |

Numbers keep their unit: `10%` is the same as `0.1` wherever an amount is expected, and a
unit that doesn't fit (`lighten(c, 10deg)`, `alpha(c, 30deg)`) is an error.

### Matching themes

`match` picks a value, or a block of rules, by the active theme. Arms are tried top to
bottom and the first match wins; `_` matches anything.

| Subject | Patterns |
| --- | --- |
| `$type` | Flags `dark`, `light`, `contrast`, combined with `&` (and), `|` (or), `!` (not) and parentheses. A high-contrast dark theme is `dark & contrast` |
| `$theme` | Quoted theme names with `*` wildcards: `"Dark Modern" | "*Light*"` |

`dark` and `light` are decided once, by the actual brightness of the theme's editor
background, and mean the same everywhere: in `match($type)`, in `offset` conditions and in
`emphasize` / `soften`. `contrast` comes from the theme's declared type. Impossible or
unreachable arms, and value matches that don't cover every theme type, are flagged as you type.

The editor shows color swatches for every value as computed for the current theme,
hover info for theme colors, completion for token types, UI colors and functions, and errors as
you type.

### Project rules

Rules that only make sense for one codebase go in `.vscode/semantic-theme.str` in that
workspace folder (**Open Project Rules** creates it), and can be committed with the project.
They use the same language and apply on save, on top of the global rules, to files in that
folder only; where a project rule and a global one are equally specific, the project rule wins.

Since settings are shared by all windows, project rules never go there: every project rule,
`struct = ...` included, is drawn as decorations over the language server's semantic tokens.
That means semantic selectors only (no UI colors or TextMate scopes), and colors that show up
once the language server has analyzed the file. Plain selectors still fill only what the theme
leaves, unless in `override`. Project rules apply in trusted workspaces only.

```
@slots => contains(text("__slots__") variable.classMember)
language(python) {
  @slots class = style(struct, bold)
  inherits(@slots) & !@slots = style(function, bold | italic)
}
```

## Commands

- **Open Rules**: edit the rules file
- **Open Project Rules**: edit (or create) the current workspace folder's `.vscode/semantic-theme.str`
- **Show Resolved Theme Colors**: where each theme color comes from, and what was generated
- **Apply Semantic Color Rules**: re-apply manually
- **Reset Rules to Defaults**
- **Remove Generated Rules**: remove everything this extension wrote to your settings

## How it works

VS Code has no API for injecting token colors, so the generated colors are written to your
user settings: semantic rules to `editor.semanticTokenColorCustomizations`, TextMate rules
to `editor.tokenColorCustomizations`, UI colors to `workbench.colorCustomizations`, all
under the active theme's name (e.g.
`"[Dark Modern]"`). Only the active theme gets a section; switching themes moves it.
Entries you wrote yourself, or edited after the extension wrote them, are never touched,
and **Remove Generated Rules** takes out everything else.

"Already colored by the theme" means an exact match: a theme rule for `struct` blocks your
`struct` rule (unless it's in `override`), but not `recordStruct`; a theme rule for
`string` doesn't block `string.quoted.docstring.python`. A more specific rule of yours is a
deliberate refinement. TextMate has a single font style per rule, so `style()` flags replace
the whole style there.

Bracket pair colorization uses `editorBracketHighlight.foreground1` to `foreground6`.
VS Code's defaults for 4 to 6 are transparent, which means "not used": brackets cycle
through the first three levels unless you set more.

Semantic colors need a language extension that provides semantic tokens, such as
C# Dev Kit, Pylance, or the built-in TypeScript support.

## Development

```sh
npm install
npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

The list of UI color IDs and their defaults ([src/uiColors.ts](src/uiColors.ts)) is
generated from VS Code's own code, since VS Code has no API for it:

```sh
node scripts/generate-ui-colors.js "<VS Code install>/resources/app/out/vs/workbench/workbench.desktop.main.js"
```
