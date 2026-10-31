import { strict as assert } from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { drawnColor, eventually, projects, setRules, tokens } from "./common";

describe("Jupyter notebooks, with Pylance", () => {
  let notebook: vscode.NotebookDocument;
  const cell = (i: number) => notebook.cellAt(i).document;
  before(async () => {
    notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(projects, "python", "notebook.ipynb")));
    await vscode.window.showNotebookDocument(notebook);
  });

  it("cells get tokens, as their own documents; names from earlier cells are 'library'", async () => {
    assert.equal(cell(0).uri.scheme, "vscode-notebook-cell");
    await eventually(async () =>
      assert.deepEqual(await tokens(cell(1), (t) => ["GrandChild", "Child"].includes(t)), ["0:GrandChild=class.declaration", "0:Child=class.library", "3:GrandChild=class"]),
    );
  });

  it("rules are drawn in cells, across cells and files", async () => {
    await setRules('inherits(text("Slotted")) class = #AA0000');
    await eventually(async () => assert.equal(await drawnColor(cell(1), 3, "GrandChild"), "#AA0000"));
    assert.equal(await drawnColor(cell(0), 2, "Child"), "#AA0000");
  });

  // What's drawn can't be read back in VS Code; that edits redraw cells is tested in the fast suite.
  it("rules follow edits to a cell", async () => {
    await setRules('text("renamed") variable = #00AA00');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell(1).uri, new vscode.Range(3, 0, 3, 1), "renamed");
    assert.ok(await vscode.workspace.applyEdit(edit));
    try {
      await eventually(async () => assert.equal(await drawnColor(cell(1), 3, "renamed"), "#00AA00"));
    } finally {
      await vscode.commands.executeCommand("undo");
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });
});
