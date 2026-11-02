# Semantic Theme Extender

Most VS Code themes color every type the same: classes, structs, interfaces, enums and type
parameters all end up one color, even though language servers like Pylance, C# Dev Kit and
rust-analyzer tell VS Code exactly which is which.

Semantic Theme Extender fills that gap for **whatever theme you use**. It derives the missing
colors from the theme's own palette, so they fit in, and leaves everything the theme already
defines alone.

It goes further than token types, too: rules can color tokens by what the language server knows
about them. Subclasses of a certain base, classes with a certain decorator, functions whose docs
say *deprecated*. Rules can also put warnings on code.

## Rules

Run **Semantic Theme Extender: Open Rules** to edit your rules. Saving applies them immediately,
and they sync across machines with Settings Sync.

```ini
; fill what the theme leaves, in colors derived from its own
struct        = offset(class, #4EC9B0, #86C691, light)
interface     = offset(class, #4EC9B0, #B8D7A3, light)
typeParameter = mix(class, function, 0.5)

; replace the theme's own color
override enum = style(emphasize(class), bold)

; per theme
match($theme) {
  "*Light*" { interface = $none }
}

; by what the language server knows
inherits(text("Exception")) class = style(class, italic)
decorated(text("dataclass")) class = struct
doc("*deprecated*") function = style(function, strikethrough)

; warnings on code
text("print") function := hint(debug-output, "left-over print")
```

Rules are skipped where the theme already colors the same thing; `override` replaces it. The
editor shows a color swatch next to every value, as computed for the current theme, with
completion, hover help and errors as you type.

A workspace can have its own rules in `.vscode/semantic-theme.str`, committed with the project:
what its tokens *are* (`class += slotted`), while your global rules say how that looks.

**[The rules language](docs/rules.md)** describes everything: selectors, conditions such as
`contains`, `inherits` and `doc`, custom modifiers, messages, color functions, matching themes
and project rules.

## Commands

- **Open Rules**: edit the rules file
- **Open Project Rules**: edit (or create) the current workspace folder's `.vscode/semantic-theme.str`
- **Inspect Token**: for the token at the cursor, its type and modifiers (custom ones with the rule or file they came from), and which drawn rules match, the winner first. VS Code's own **Inspect Editor Tokens and Scopes** can't show custom modifiers: they only exist in this extension
- **Show Resolved Theme Colors**: where each theme color comes from, and what was generated
- **Apply Semantic Color Rules**: re-apply manually
- **Reset Rules to Defaults**
- **Remove Generated Rules**: remove everything this extension wrote to your settings

## How it works

VS Code has no API for injecting token colors, so plain rules (`struct = …`) are written to your
user settings: semantic rules to `editor.semanticTokenColorCustomizations`, TextMate rules to
`editor.tokenColorCustomizations`, UI colors to `workbench.colorCustomizations`, all under the
active theme's name (e.g. `"[Dark Modern]"`). Only the active theme gets a section; switching
themes moves it. Entries you wrote yourself, or edited after the extension wrote them, are never
touched, and **Remove Generated Rules** takes out everything else.

Rules with conditions (`inherits(…)`, `text(…)`, …) are drawn as editor decorations over the
language server's semantic tokens instead, shortly after it has analyzed the file.

Semantic colors need a language extension that provides semantic tokens, such as Pylance, C#
Dev Kit, rust-analyzer, or the built-in TypeScript support. What each condition can do depends
on the language server: TypeScript and rust-analyzer have no type hierarchy, for example, so
`inherits` can't match there, and the rules file says so.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building and testing.
