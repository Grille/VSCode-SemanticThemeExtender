import "./fake-vscode";
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { conditionText, parseRulesFile, Rule, stripCondition } from "../src/cfg";
import { planRule } from "../src/plan";
import { TokenRegistry } from "../src/theme";

/** What a head becomes: the settings selectors it is written as, or "drawn". */
function plan(head: string, target?: "semantic" | "textmate" | "ui") {
  const f = parseRulesFile(`${head} = #111111`);
  assert.deepEqual(f.problems, []);
  const p = planRule((f.stmts[0] as Rule).head, target, new TokenRegistry());
  return { as: p.decoration ? `drawn: ${conditionText(stripCondition(p.decoration))}` : p.names, problems: p.problems.map((x) => x.message) };
}

describe("settings or decorations", () => {
  it("plain selectors and | go to settings", () => {
    assert.deepEqual(plan("struct | enum").as, ["struct", "enum"]);
    assert.deepEqual(plan("editorBracketHighlight.foreground1").as, ["editorBracketHighlight.foreground1"]);
    assert.deepEqual(plan("string.quoted.docstring.python").as, ["string.quoted.docstring.python"]);
  });

  it("combinations that are one selector are merged", () => {
    assert.deepEqual(plan("variable *.readonly").as, ["variable.readonly"]);
    assert.deepEqual(plan("language(python) selfParameter").as, ["selfParameter:python"]);
    assert.deepEqual(plan("language(python, csharp) struct").as, ["struct:python", "struct:csharp"]);
  });

  it("everything else is drawn", () => {
    assert.deepEqual(plan('text("x") variable').as, 'drawn: text("x") variable');
    assert.deepEqual(plan("!struct").as, "drawn: !struct");
    assert.deepEqual(plan("class.slotted").as, "drawn: class.slotted");
    assert.deepEqual(plan("decorated(text(\"dataclass\")) class").as, 'drawn: decorated(text("dataclass")) class');
  });
});

describe("problems", () => {
  it("parts that can never match", () => {
    assert.deepEqual(plan("language(python) struct:csharp | enum").problems, ["Part of this can never match: two different token types or languages"]);
  });

  it("TextMate scopes and UI colors only stand alone", () => {
    assert.deepEqual(plan('text("x") editor.background').problems, ["TextMate scopes and UI colors can't be combined with other conditions; only semantic selectors can"]);
  });

  it("* alone, and modifiers written as types", () => {
    assert.match(plan("*").problems[0], /^'\*' alone needs a modifier/);
    assert.match(plan("classMember").problems[0], /^'classMember' is a modifier, not a token type/);
  });

  it("unknown languages are a warning", () => {
    assert.deepEqual(plan("language(pyhton) struct").problems, ["Unknown language 'pyhton'; language ids look like python, csharp, typescript"]);
  });
});
