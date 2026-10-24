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
$accent = match $type {
  dark & contrast -> emphasize(class, 20%)
  _               -> emphasize(class)
}

; rules fill what the theme leaves: skipped where the theme colors the token itself
struct        = hue(class, -35)
interface     = mix(class, function, 0.5)
typeParameter = mix(class, function, 0.5)
selfParameter:python = variable.language

; override also replaces the theme's own colors: one rule, or a block
override enum = style($accent, bold | !italic)
override {
  namespace = soften(variable)
}

; a block of rules for matching themes
match $theme {
  "Dark Modern" | "Dark 2026" {
    struct = $structLike
  }
  "*Light*" {
    interface = $none
  }
}
```

| Syntax | Meaning |
| --- | --- |
| `selector = value` | Rule; skipped where the theme colors that token itself. Later rules override earlier ones |
| `override selector = value`, `override { rules }` | Rules that also replace the theme's own colors |
| `struct`, `parameter:python`, `*.static` | Selector: a semantic token type, optionally with modifiers or a language |
| `class`, `function` | The active theme's color for that semantic token type |
| `variable.language` | The active theme's color for a TextMate scope (any name with a dot) |
| `$name = color` | Variable: top level only, assigned once |
| `#86C691`, `rgb(134, 198, 145)` | A literal color |
| `emphasize(c, 10%)`, `soften(c, 10%)` | More / less contrast to the editor background: lighter on dark themes, darker on light ones |
| `lighten(c, 10%)`, `darken`, `saturate`, `desaturate` | Adjust lightness or chroma (OKLCH) |
| `hue(c, 30)` | Rotate the hue by degrees |
| `mix(a, b, 0.5)`, `alpha(c, 50%)` | Blend two colors, set opacity |
| `style(c, bold | !italic)` | Font styles; `style(underline)` keeps the theme's color |
| `$none` | No rule for this selector |

### Matching themes

`match` picks a value, or a block of rules, by the active theme. Arms are tried top to
bottom and the first match wins; `_` matches anything.

| Subject | Patterns |
| --- | --- |
| `$type` | Flags `dark`, `light`, `contrast`, combined with `&` (and), `|` (or), `!` (not) and parentheses. A high-contrast dark theme is `dark & contrast` |
| `$theme` | Quoted theme names with `*` wildcards: `"Dark Modern" | "*Light*"` |

`$type` comes from the type a theme declares; `emphasize` and `soften` instead look at the
actual brightness of its editor background. Impossible or unreachable arms, and value
matches that don't cover every theme type, are flagged as you type.

The editor shows color swatches for every value as computed for the current theme,
hover info for theme colors, completion for token types and functions, and errors as
you type.

## Commands

- **Open Rules**: edit the rules file
- **Show Resolved Theme Colors**: where each theme color comes from, and what was generated
- **Apply Semantic Color Rules**: re-apply manually
- **Reset Rules to Defaults**
- **Remove Generated Rules**: remove everything this extension wrote to your settings

## How it works

The generated colors are written to `editor.semanticTokenColorCustomizations` under the
active theme's name (e.g. `"[Dark Modern]"`). Rules you wrote there yourself are never
touched. Because they are regular settings, other machines get the colors through
Settings Sync even before the extension is installed there.

Semantic colors need a language extension that provides semantic tokens, such as
C# Dev Kit, Pylance, or the built-in TypeScript support.

## Development

```sh
npm install
npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host.
