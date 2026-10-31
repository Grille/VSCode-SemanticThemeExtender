import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as vscode from "vscode";
import { drawnColor, eventually, inspect, open, setRules, tokens, unsupportedWarnings } from "./common";

// rust-analyzer answers with tokens from the syntax alone until the crate is loaded (traits are
// structs then, f64 a namespace); hovers come only after.
const LOAD_MS = 180_000;

const symbolCount = async (doc: vscode.TextDocument) =>
  ((await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri)) ?? []).length;

describe("Rust, with rust-analyzer", function () {
  let main: vscode.TextDocument;
  before(async function () {
    // rust-analyzer can't load a crate without a toolchain (rustup.rs).
    if (spawnSync("cargo", ["--version"], { shell: true }).status !== 0) this.skip();
    main = await open("rust/src/main.rs");
    await eventually(async () => {
      const h = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", main.uri, new vscode.Position(9, 11));
      assert.ok(h.length, "crate not loaded yet");
    }, LOAD_MS);
    // In some starts the file's symbols stay empty until its next edit (see the README); one edit,
    // reverted, gets them.
    if (!(await symbolCount(main))) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(main.uri, new vscode.Position(36, 0), "\n");
      await vscode.workspace.applyEdit(edit);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
    await eventually(async () => assert.ok(await symbolCount(main), "no symbols"));
    // Pages opening while the extensions start (release notes and such) can hide the file; only
    // files on screen are drawn.
    await vscode.window.showTextDocument(main);
  });

  describe("what rust-analyzer reports", () => {
    it("token types: traits are interfaces, #[deprecated] is a modifier", async () => {
      await eventually(async () =>
        assert.deepEqual(await tokens(main, (t) => ["Polygon", "Point", "make"].includes(t)), [
          "4:Polygon=interface.declaration.public",
          "9:Point=struct.declaration.public",
          "13:Point=struct.public",
          "19:Polygon=interface.public",
          "19:Point=struct.public",
          "26:make=function.declaration.deprecated.public",
          "26:Point=struct.public",
          "27:Point=struct.public",
          "32:make=function.deprecated.public",
        ]),
      );
    });

    it("has no type hierarchy, so inherits() can't work here", async () => {
      const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", main.uri, new vscode.Position(9, 11));
      assert.deepEqual((items ?? []).map((i) => i.name), []);
    });
  });

  describe("the extension", () => {
    it("server(): rust-analyzer serves rust, though it starts on Cargo.toml", async () => {
      assert.ok((await inspect(main, 9, "Point")).includes("  servers: rust-lang.rust-analyzer  (server(...) matches these)"));
      await setRules("server(rust-lang.rust-analyzer) struct = #AA0000");
      await eventually(async () => assert.equal(await drawnColor(main, 9, "Point"), "#AA0000"));
    });

    it("decorated(): #[attributes]", async () => {
      await setRules('decorated(text("derive")) struct = #AA0000', 'decorated(text("deprecated")) function = #00AA00');
      await eventually(async () => assert.equal(await drawnColor(main, 9, "Point"), "#AA0000"));
      await eventually(async () => assert.equal(await drawnColor(main, 26, "make"), "#00AA00"));
      assert.equal(await drawnColor(main, 30, "main"), undefined);
    });

    it("doc(): /// comments, across files", async () => {
      await setRules('doc("*corners*") interface = #AA0000', 'doc("*marker*") interface = #00AA00');
      await eventually(async () => assert.equal(await drawnColor(main, 4, "Polygon"), "#AA0000"));
      await eventually(async () => assert.equal(await drawnColor(main, 1, "Shape"), "#00AA00"));
    });

    it("contains(): fields", async () => {
      await setRules('contains(text("x")) struct = #AA0000');
      await eventually(async () => assert.equal(await drawnColor(main, 9, "Point"), "#AA0000"));
      assert.equal(await drawnColor(main, 33, "Slotted"), undefined);
    });

    it("inherits(): a warning on the rule, since there's no type hierarchy", async () => {
      await setRules('inherits(text("Shape")) = #AA0000');
      await eventually(() => assert.deepEqual(unsupportedWarnings("rust"), ["inherits() can't match in rust: its language server provides no type hierarchy (seen in main.rs)"]));
    });
  });
});
