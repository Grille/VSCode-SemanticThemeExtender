# Changelog

## 0.1.0

- Rules file with variables, theme color references, color functions and `style()`.
- Rules fill only what the theme leaves; `override { }` blocks replace theme colors; `$none`.
- `match $type` (flags `dark`, `light`, `contrast`) and `match $theme`, as values or rule blocks.
- `emphasize` / `soften`: contrast-aware lightening or darkening based on the editor background.
- `offset(c, base, target, light)`: transfer a measured color relationship to any theme, flipping lightness where a `$type` condition holds; defaults use it to reproduce Visual Studio's type colors.
- `dark` / `light` are decided once from the editor background, the same for `match $type` and every contrast-aware function.
- TextMate scopes as selectors; semantic rules also set their TextMate fallback scope.
- UI colors by their ID, read and written, e.g. bracket pair colors derived from the theme.
- `ui`, `semantic` and `textmate` say what kind of name a rule or value uses, for one rule or a block.
- Settings only hold a section for the active theme; "already colored" means an exact theme rule.
- Synced rules editor with diagnostics, color swatches, hover and completion.
