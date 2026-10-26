import { strict as assert } from "assert";
import * as vscode from "vscode";
import { drawnColor, eventually, open, setRules, tokens, unsupportedWarnings } from "./common";

describe("TypeScript, built in", () => {
  let main: vscode.TextDocument;
  before(async () => {
    main = await open("typescript/main.ts");
  });

  describe("what VS Code's TypeScript support reports", () => {
    it("token types of decorators and methods", async () => {
      await eventually(async () =>
        assert.deepEqual(await tokens(main, (t) => ["sealed", "make"].includes(t)), ["2:sealed=function.declaration", "8:sealed=function", "11:make=method.declaration.static"]),
      );
    });

    it("has no type hierarchy, so inherits() can't work here", async () => {
      const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", main.uri, new vscode.Position(6, 13));
      assert.deepEqual((items ?? []).map((i) => i.name), []);
    });
  });

  describe("the extension", () => {
    it("decorated(): decorators", async () => {
      await setRules('decorated(text("sealed")) class = #AA0000');
      await eventually(async () => assert.equal(await drawnColor(main, 9, "Point"), "#AA0000"));
      assert.equal(await drawnColor(main, 4, "Child"), undefined);
    });

    it("inherits(): a warning on the rule, since there's no type hierarchy", async () => {
      await setRules('inherits(text("Slotted")) class = #AA0000');
      await eventually(() =>
        assert.deepEqual(unsupportedWarnings(), ["inherits() can't match in typescript: its language server provides no type hierarchy (seen in main.ts)"]),
      );
    });

    it("contains(): members", async () => {
      await setRules('contains(text("make")) class = #00AA00');
      await eventually(async () => assert.equal(await drawnColor(main, 12, "Point"), "#00AA00"));
    });
  });
});
