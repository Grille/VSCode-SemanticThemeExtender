# Changelog

## 0.1.0

- Rules file with variables, theme color references, color functions and `style()`.
- Rules fill only what the theme leaves; `override { }` blocks replace theme colors; `$none`.
- `match($type)` (flags `dark`, `light`, `contrast`) and `match($theme)`, as values or rule blocks.
- `emphasize` / `soften`: contrast-aware lightening or darkening based on the editor background.
- `offset(c, base, target, light)`: transfer a measured color relationship to any theme, flipping lightness where a `$type` condition holds; defaults use it to reproduce Visual Studio's type colors.
- `dark` / `light` are decided once from the editor background, the same for `match($type)` and every contrast-aware function.
- TextMate scopes as selectors; semantic rules also set their TextMate fallback scope.
- UI colors by their ID, read and written, e.g. bracket pair colors derived from the theme.
- Rule heads are selector expressions: `struct | enum`, `language(python) selfParameter`, `text(...)`, `contains(...)`, combined with `&` (or side by side), `|`, `!` and parentheses; plain selectors still go to settings, everything else is drawn as decorations.
- `contains(...)`: color classes (or other symbols) by what they contain, e.g. classes defining `__slots__`, also where they're used in other files.
- `within(...)`: tokens inside a matching symbol; `inherits(...)`: types with a matching base type, across files, via the type hierarchy.
- Custom modifiers: `head += slotted` gives matching tokens a modifier any rule can select (`class.slotted`), across rules files; names used in another file take over their definition's custom modifiers.
- Regular expression literals (`/^Dark/i`) wherever a pattern is taken, next to quoted globs.
- `doc("*deprecated*")`: tokens whose documentation (hover prose) matches; `signature("*: Callable*")`: tokens whose signature or type (hover code) matches.
- Messages: `head := warn("{text} ...")` (or `error`, `info`, `hint`) puts a diagnostic on every matching token in open files; `warn(name, "...")` names one, and `semantic-theme: ignore [name]` in a comment silences it, with a quick fix to add that comment.
- **Inspect Token** command: type, modifiers (custom ones with their origin) and matching drawn rules for the token at the cursor.
- Project rules in `.vscode/semantic-theme.str`: per workspace folder, applied on save, drawn as decorations so windows don't share them; trusted workspaces only.
- `@name => head` names a selector expression for reuse in heads as `@name`.
- `text()` and `contains()` conditions combine with `&`, `|`, `!` and parentheses.
- Token text filters: `text("__slots__") variable.classMember = ...` colors only tokens with that text, as decorations over the language server's tokens.
- `hue(c, 5%)` shifts the hue by a visible distance, the same on muted and saturated colors; `offset` carries hue changes over the same way.
- `ui`, `semantic` and `textmate` say what kind of name a rule or value uses, for one rule or a block.
- Settings only hold a section for the active theme; "already colored" means an exact theme rule.
- Synced rules editor with diagnostics, color swatches, hover and completion.
