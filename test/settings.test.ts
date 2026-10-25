import "./fake-vscode";
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { normalizeOwned, strip, write } from "../src/settings";

const generated = {
  rules: { struct: "#86C691", enum: "#B8D7A3" },
  textMate: { "entity.name.type.struct": { foreground: "#86C691" }, "entity.name.type.enum": { foreground: "#B8D7A3" }, comment: { foreground: "#6A9955" } },
  ui: { "editorBracketHighlight.foreground1": "#FFD700" },
};

describe("writing settings", () => {
  it("fills the theme's section and groups TextMate rules with the same settings", () => {
    const next = write({ semantic: {}, textMate: {}, ui: {} }, "[Test Dark]", generated, true);
    assert.deepEqual(next.semantic, { "[Test Dark]": { rules: { struct: "#86C691", enum: "#B8D7A3" }, enabled: true } });
    assert.deepEqual(next.textMate["[Test Dark]"].textMateRules, [
      { scope: "entity.name.type.struct", settings: { foreground: "#86C691" } },
      { scope: "entity.name.type.enum", settings: { foreground: "#B8D7A3" } },
      { scope: "comment", settings: { foreground: "#6A9955" } },
    ]);
    assert.deepEqual(next.ui, { "[Test Dark]": { "editorBracketHighlight.foreground1": "#FFD700" } });
    const same = write({ semantic: {}, textMate: {}, ui: {} }, "[T]", { rules: {}, textMate: { a: { foreground: "#111111" }, b: { foreground: "#111111" } }, ui: {} }, false);
    assert.deepEqual(same.textMate["[T]"].textMateRules, [{ scope: ["a", "b"], settings: { foreground: "#111111" } }]);
  });

  it("never touches what the user wrote, and strips exactly what it owns", () => {
    const user = {
      semantic: { "[Test Dark]": { rules: { struct: "#FF0000", "variable.readonly": "#00FF00" } }, "[Other]": { rules: { x: "#000000" } } },
      textMate: { "[Test Dark]": { textMateRules: [{ scope: "comment", settings: { foreground: "#123456" } }] } },
      ui: { "[Test Dark]": { "editor.background": "#000000" } },
    };
    const next = write(user, "[Test Dark]", generated, true);
    // The user's struct stays; ours fills the gaps around it.
    assert.deepEqual(next.semantic["[Test Dark]"].rules, { struct: "#FF0000", "variable.readonly": "#00FF00", enum: "#B8D7A3" });
    assert.deepEqual(next.owned.semantic, { "[Test Dark]": ["enum"] });
    // Our TextMate entries go first, so the user's win on equal scopes.
    assert.deepEqual(next.textMate["[Test Dark]"].textMateRules.at(-1), { scope: "comment", settings: { foreground: "#123456" } });

    const back = strip(next, normalizeOwned(next.owned));
    assert.deepEqual(back, user);
  });

  it("strip removes empty sections it leaves behind", () => {
    const next = write({ semantic: {}, textMate: {}, ui: {} }, "[Test Dark]", generated, true);
    assert.deepEqual(strip(next, next.owned), { semantic: {}, textMate: {}, ui: {} });
  });
});
