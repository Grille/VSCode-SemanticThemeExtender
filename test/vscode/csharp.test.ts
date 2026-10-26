import { strict as assert } from "assert";
import * as vscode from "vscode";
import { drawnColor, eventually, open, setRules, tokens } from "./common";

// The C# extension loads the project first; that takes a while.
const LOAD_MS = 150_000;

describe("C#, with the C# extension", () => {
  let main: vscode.TextDocument;
  before(async () => {
    main = await open("csharp/Main.cs");
  });

  describe("what the C# extension reports", () => {
    it("token types: base types from other files are classes, [Obsolete] methods aren't methods", async () => {
      await eventually(
        async () => assert.deepEqual(await tokens(main, (t) => ["Slotted", "Obsolete", "Make"].includes(t)), ["4:Slotted=class", "19:Obsolete=class", "20:Make=namespace.deprecated"]),
        LOAD_MS,
      );
    });
  });

  describe("the extension", () => {
    it("inherits(): through the type hierarchy, across files", async () => {
      await setRules('inherits(text("Slotted")) class = #AA0000');
      await eventually(async () => assert.equal(await drawnColor(main, 28, "GrandChild"), "#AA0000"), LOAD_MS);
      assert.equal(await drawnColor(main, 15, "Point"), undefined);
    });

    it("decorated(): attributes, on classes and members", async () => {
      await setRules('decorated(text("Serializable")) class = #00AA00', 'decorated(text("Obsolete")) = #0000AA');
      await eventually(async () => assert.equal(await drawnColor(main, 15, "Point"), "#00AA00"));
      assert.equal(await drawnColor(main, 20, "Make"), "#0000AA");
    });

    it("doc(): /// summaries, without Markdown escapes", async () => {
      await setRules('doc("*marker. @struct*") class = #AA00AA');
      await eventually(async () => assert.equal(await drawnColor(main, 4, "Slotted"), "#AA00AA"));
    });
  });
});
