# Changelog

## 0.1.0

- Rules file with variables, theme color references, color functions and `style()`.
- Rules fill only what the theme leaves; `override { }` blocks replace theme colors; `$none`.
- `match $type` (flags `dark`, `light`, `contrast`) and `match $theme`, as values or rule blocks.
- `emphasize` / `soften`: contrast-aware lightening or darkening based on the editor background.
- `offset(c, base, target, light)`: transfer a measured color relationship to any theme, flipping lightness where a `$type` condition holds; defaults use it to reproduce Visual Studio's type colors.
- `dark` / `light` are decided once from the editor background, the same for `match $type` and every contrast-aware function.
- Synced rules editor with diagnostics, color swatches, hover and completion.
