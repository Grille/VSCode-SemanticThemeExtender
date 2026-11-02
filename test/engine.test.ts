import "./fake-vscode";
import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { describe, it } from "node:test";
import { conditionText, DEFAULT_RULES } from "../src/cfg";
import { compileRules, errors, hints, warnings } from "./helpers";

const example = (file: string) => fs.readFileSync(path.join(__dirname, "..", "..", "examples", file), "utf8");

describe("default rules", () => {
  it("reproduce Visual Studio's type colors exactly where class has VS Code's color", () => {
    const r = compileRules(DEFAULT_RULES);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.rules, {
      struct: "#86C691",
      interface: "#B8D7A3",
      enum: "#B8D7A3",
      typeParameter: "#B8D7A3",
      "selfParameter:python": "#569CD6",
      "clsParameter:python": "#569CD6",
    });
    // Semantic rules also set the TextMate scopes VS Code falls back to.
    assert.deepEqual(r.textMate["entity.name.type.struct"], { foreground: "#86C691" });
  });

  it("flip lightness on a light theme", () => {
    const r = compileRules(DEFAULT_RULES, {}, "Test Light");
    assert.deepEqual(r.problems, []);
    assert.notEqual(r.rules.struct, "#86C691");
  });
});

describe("filling gaps", () => {
  it("skips what the theme colors itself, unless override", () => {
    const r = compileRules(["enumMember = #111111", "keyword.control = #222222", "editorCursor.foreground = #333333"]);
    assert.deepEqual([r.rules, r.textMate, r.ui], [{}, {}, {}]);
    const o = compileRules(["override {", "  enumMember = #111111", "  keyword.control = #222222", "  editorCursor.foreground = #333333", "}"]);
    assert.deepEqual(o.rules, { enumMember: "#111111" });
    // enumMember also brings its TextMate fallback scope.
    assert.deepEqual(o.textMate, { "variable.other.enummember": { foreground: "#111111" }, "keyword.control": { foreground: "#222222" } });
    assert.deepEqual(o.ui, { "editorCursor.foreground": "#333333" });
  });

  it("writes UI colors and TextMate scopes the theme leaves", () => {
    const r = compileRules(["editorBracketHighlight.foreground1 = soften(keyword)", "string.quoted.docstring.python = #6A9955"]);
    assert.deepEqual(r.problems, []);
    assert.ok(r.ui["editorBracketHighlight.foreground1"]);
    assert.deepEqual(r.textMate["string.quoted.docstring.python"], { foreground: "#6A9955" });
  });

  it("an explicit semantic rule leaves the TextMate fallback alone", () => {
    const r = compileRules(["semantic struct = #123456"]);
    assert.deepEqual(r.rules, { struct: "#123456" });
    assert.deepEqual(r.textMate, {});
  });
});

describe("rules that are drawn", () => {
  it("collects decorations, custom modifiers and messages with their lines", () => {
    const r = compileRules([
      '@slots => contains(text("__slots__") variable.classMember)',
      "@slots class += slotted",
      "class.slotted = #111111",
      'class.slotted := warn(slotted, "{text} has slots")',
    ]);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(r.rules, {});
    assert.deepEqual(r.tagRules.map((t) => [t.modifiers, t.line]), [[["slotted"], 2]]);
    assert.deepEqual(r.textRules.map((t) => [t.style, t.line]), [["#111111", 3]]);
    assert.deepEqual(r.messageRules.map((m) => [m.severity, m.code, m.line]), [["warn", "slotted", 4]]);
  });

  it("a later rule with the same head replaces an earlier one, $none removes it", () => {
    const r = compileRules(['text("x") variable = #111111', 'text("x") variable = #222222', 'text("y") variable = #333333', 'text("y") variable = $none']);
    assert.deepEqual(r.textRules.map((t) => t.style), ["#222222"]);
  });
});

describe("theme conditions", () => {
  const both = (lines: string[]) => ["Test Dark", "Test Light"].map((theme) => compileRules(lines, {}, theme));

  it("theme() takes globs and regular expressions, any case for globs", () => {
    const [dark, light] = both(["theme(/^test d/i) { struct = #111111 }", 'theme("*LIGHT*") { struct = #222222 }']);
    assert.deepEqual([errors(dark), errors(light)], [[], []]);
    assert.deepEqual([dark.rules.struct, light.rules.struct], ["#111111", "#222222"]);
  });

  it("dark, light, contrast combine with each other and with token conditions", () => {
    const [dark, light] = both(["dark & !contrast { enum = #111111 }", "light enum = #222222", 'dark text("x") variable = #333333']);
    assert.deepEqual([dark.rules.enum, light.rules.enum], ["#111111", "#222222"]);
    // What's left once the theme is decided is about tokens: drawn, without the theme part.
    assert.deepEqual(dark.textRules.map((t) => conditionText(t.when)), ['text("x") variable']);
    assert.deepEqual(light.textRules, []);
  });

  it("rules for other themes are still checked; theme conditions alone are no rule", () => {
    const r = compileRules(['theme("Nope") { strct = #111111 }', "dark = #222222"]);
    assert.deepEqual(errors(r), ["2: Theme conditions alone don't say which tokens; add a selector, e.g. dark struct"]);
    assert.match(warnings(r)[0], /^1: Unknown token type 'strct'/);
  });
});

describe("project files", () => {
  it("draw plain selectors instead of writing settings", () => {
    const r = compileRules(["struct = #111111", "function = #222222", "override function = #333333"], { project: true });
    assert.deepEqual([r.rules, r.textMate], [{}, {}]);
    // function is colored by the theme (entity.name.function), so only the override is drawn.
    assert.deepEqual(r.textRules.map((t) => [JSON.stringify(t.when), t.style]), [
      ['{"kind":"selector","selector":"struct"}', "#111111"],
      ['{"kind":"selector","selector":"function"}', "#333333"],
    ]);
  });

  it("reject UI colors and TextMate scopes, and warn about colors", () => {
    const r = compileRules(["editor.background = #000000", "string.quoted = #111111", "struct = #222222", "class += x"], { project: true });
    assert.deepEqual(errors(r), [
      "1: Project rules only color semantic tokens; UI colors and TextMate scopes ('editor.background') go in the global rules",
      "2: Project rules only color semantic tokens; UI colors and TextMate scopes ('string.quoted') go in the global rules",
    ]);
    assert.equal(warnings(r).length, 1);
    assert.match(warnings(r)[0], /^3: Project files are for what tokens are/);
  });
});

describe("custom modifiers", () => {
  it("hint when nothing in the file assigns them", () => {
    const r = compileRules(["class.redonly = #111111", "class += slotted", "class.slotted = #222222"]);
    assert.deepEqual(hints(r), ["1: 'redonly' is no modifier of any language server; as a custom modifier it only matches tokens a += rule gives it"]);
  });

  it("stay TextMate scopes as plain names after string, comment, keyword, variable", () => {
    const r = compileRules(["variable.slotted = #111111", "semantic variable.slotted = #222222", "class.slotted = #333333"]);
    assert.deepEqual(r.textMate, { "variable.slotted": { foreground: "#111111" } });
    assert.deepEqual(r.textRules.map((t) => t.style), ["#222222", "#333333"]);
  });
});

describe("examples", () => {
  it("the showcase reports exactly its intended mistakes", () => {
    const r = compileRules(example("showcase.ste"));
    const all = [...errors(r), ...warnings(r)].map((p) => p.replace(/:.*/, "")).sort((a, b) => +a - +b);
    assert.equal(all.length, 6, [...errors(r), ...warnings(r)].join("\n"));
  });

  it("the example project file is clean", () => {
    const r = compileRules(example(".vscode/semantic-theme.ste"), { project: true });
    assert.deepEqual([...errors(r), ...warnings(r), ...hints(r)], []);
  });
});
