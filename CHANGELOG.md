# Changelog

## 0.1.0

- Rules file with variables, theme color references, color functions and `style()`.
- Rules fill only what the theme leaves; `override { }` blocks replace theme colors; `$none`.
- `match $type` (flags `dark`, `light`, `contrast`) and `match $theme`, as values or rule blocks.
- `emphasize` / `soften`: contrast-aware lightening or darkening based on the editor background.
- Synced rules editor with diagnostics, color swatches, hover and completion.
