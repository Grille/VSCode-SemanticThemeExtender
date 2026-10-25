import "./fake-vscode";
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { conditionText, matchesPattern, parseRulesFile, Rule, stripCondition } from "../src/cfg";

const parse = (lines: string[]) => parseRulesFile(lines.join("\n"));
const problems = (lines: string[]) => parse(lines).problems.map((p) => `${p.range.start.line + 1}: ${p.message}`);
/** The text of every rule's head, as the parser understood it. */
const heads = (lines: string[]) => parse(lines).stmts.filter((s): s is Rule => s.kind === "rule").map((r) => conditionText(stripCondition(r.head)));

describe("heads", () => {
  it("side by side means and, with | ! and parentheses", () => {
    assert.deepEqual(heads(['text("__slots__") variable.classMember = #111111']), ['text("__slots__") variable.classMember']);
    assert.deepEqual(heads(["struct | !(enum interface) = #111111"]), ["struct | !(enum interface)"]);
  });

  it("names keep a language, and := splits off without spaces", () => {
    const f = parse(["parameter:python = #111111", 'class:=warn("x")']);
    assert.deepEqual(f.problems, []);
    assert.deepEqual(f.stmts.map((s) => s.kind), ["rule", "message"]);
  });

  it("symbol conditions nest", () => {
    assert.deepEqual(heads(['inherits(decorated(text("dataclass")) & contains(doc("*x*") method)) class = #111111']), [
      'inherits(decorated(text("dataclass")) contains(doc("*x*") method)) class',
    ]);
  });
});

describe("@expressions", () => {
  it("are replaced where used, also before their declaration", () => {
    const f = parse(["@slotted class = #111111", '@slotted => contains(text("__slots__") variable.classMember)']);
    assert.deepEqual(f.problems, []);
    assert.equal(conditionText(stripCondition((f.stmts[0] as Rule).head)), 'contains(text("__slots__") variable.classMember) class');
  });

  it("report unknown names, cycles, unused ones and $ mix-ups", () => {
    assert.deepEqual(problems(["@a => @b class", "@b => @a", "@nope class = #111111", "@unused => class", "$x class = #111111"]), [
      "5: $x is a color; named selector expressions start with @: @x => ...",
      "2: @a refers to itself",
      "3: Unknown expression @nope; declare it with @nope => ...",
      "4: @unused is never used",
    ]);
  });

  it("@name = value is a rule, not a declaration", () => {
    const f = parse(["@types => struct | enum", "language(python) {", "  @types = #111111", "}"]);
    assert.deepEqual(f.problems, []);
    assert.equal(f.expressions.size, 1);
  });
});

describe("+= and :=", () => {
  it("take modifier names on the same line", () => {
    assert.deepEqual(problems(["class += slotted, leaky", "class +=", "class += a.b"]), [
      "2: Expected a modifier name like slotted",
      "3: Expected a modifier name like slotted",
    ]);
  });

  it("messages take a severity, an optional name and a quoted message", () => {
    const f = parse(['class := warn(leaky-slots, "{text}")', 'class := hint("h")']);
    assert.deepEqual(f.problems, []);
    assert.deepEqual(f.stmts.map((s) => s.kind === "message" && [s.severity, s.code, s.message]), [
      ["warn", "leaky-slots", "{text}"],
      ["hint", undefined, "h"],
    ]);
    assert.deepEqual(problems(['class := shout("x")', "class := warn(x)", 'class := warn("unclosed"', "struct = #111111"]), [
      '1: Expected warn("message") or warn(name, "message"), or error, info or hint; {text} in the message is the token',
      "2: Expected ',' and the message after the name, found ')'",
      "3: Expected ')' to close warn(...)",
    ]);
  });
});

describe("patterns", () => {
  it("regular expressions keep escapes, / in classes, and don't start comments", () => {
    const f = parse(["text(/a\\/b/, /[/;]x/i) * = #111111 ; a comment"]);
    assert.deepEqual(f.problems, []);
    const head = stripCondition((f.stmts[0] as Rule).head);
    assert.equal(conditionText(head), "text(/a\\/b/, /[/;]x/i) *");
  });

  it("invalid regular expressions are errors", () => {
    assert.deepEqual(problems(["text(/(x/) variable = #111111", "text(/x/g) variable = #111111", "text(/x) variable = #111111"]), [
      "3: Unclosed regular expression: it ends with / on the same line, e.g. /^Dark/i",
      "1: Invalid regular expression: /(x/: Unterminated group",
      "2: Invalid regular expression: the g and y flags have no meaning here",
      '3: Expected the token text in quotes or a /regex/, e.g. text("__slots__")',
    ]);
  });

  it("theme names take globs and regular expressions", () => {
    const f = parse(["match($theme) {", "  /^dark/i { class = #111111 }", '  "*Light*" { class = #222222 }', "}"]);
    assert.deepEqual(f.problems, []);
    const block = f.stmts[0];
    assert.ok(block.kind === "block");
    const pick = (id: string) => block.arms.map((a) => matchesPattern(a.pattern, new Set(), id));
    assert.deepEqual(pick("Dark Modern"), [true, false]);
    assert.deepEqual(pick("Light Modern"), [false, true]);
    assert.deepEqual(pick("Monokai"), [false, false]);
  });
});

describe("statements", () => {
  it("recover after an error and keep going", () => {
    assert.deepEqual(problems(["struct = mix(class,", "enum = #111111", "interface = = #222222", "typeParameter = #333333"]), [
      "1: Unclosed '(' in mix()",
      "3: Unexpected '='",
    ]);
  });

  it("warn about a selector set twice in one block", () => {
    assert.deepEqual(problems(["struct = #111111", "struct = #222222"]), ["2: 'struct' is already set on line 1 in this block; this one wins"]);
  });

  it("variables are assigned once, at the top level", () => {
    assert.deepEqual(problems(["$a = #111111", "$a = #222222", "language(python) {", "  $b = #333333", "}"]), [
      "2: $a is already assigned on line 1; variables can only be assigned once",
      "4: Variables can only be declared at the top level; use a match value instead: $x = match($type) { ... }",
    ]);
  });
});
