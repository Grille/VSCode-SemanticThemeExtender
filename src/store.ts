// The rules text lives in globalState (synced via Settings Sync) and is exposed to the
// editor as the virtual file semantic-theme-rules:/rules.ste.

import * as vscode from "vscode";
import { DEFAULT_RULES } from "./cfg";

const TEXT_KEY = "semanticThemeExtender.rulesText";
export const RULES_URI = vscode.Uri.parse("semantic-theme-rules:/rules.ste");

export class RulesStore implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly textChanged = new vscode.EventEmitter<string>();
  /** Fires when the rules text changes, by saving or by Settings Sync. */
  readonly onDidChangeText = this.textChanged.event;

  private lastSeen: string;
  private mtime = Date.now();

  constructor(private readonly state: vscode.Memento & { setKeysForSync(keys: readonly string[]): void }, syncKeys: string[]) {
    state.setKeysForSync([TEXT_KEY, ...syncKeys]);
    this.lastSeen = this.text;
  }

  get text(): string {
    return this.state.get<string>(TEXT_KEY) ?? DEFAULT_RULES;
  }

  async setText(text: string) {
    await this.state.update(TEXT_KEY, text);
    this.noteChange();
  }

  /** globalState has no change event, so synced updates are picked up by polling this. */
  checkForExternalChange() {
    if (this.text !== this.lastSeen) {
      this.noteChange();
    }
  }

  /**
   * Editors restored at startup may have tried to read the file before this provider was
   * registered and show it empty; a change event makes them read it again.
   */
  announce() {
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: RULES_URI }]);
  }

  private noteChange() {
    this.lastSeen = this.text;
    this.mtime = Date.now();
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: RULES_URI }]);
    this.textChanged.fire(this.lastSeen);
  }

  // FileSystemProvider: a single file at the root.

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path === "/") {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    this.assertRulesFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtime, size: Buffer.byteLength(this.text) };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [["rules.ste", vscode.FileType.File]];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    this.assertRulesFile(uri);
    return Buffer.from(this.text, "utf8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array) {
    this.assertRulesFile(uri);
    await this.setText(Buffer.from(content).toString("utf8"));
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  private assertRulesFile(uri: vscode.Uri) {
    if (uri.path !== RULES_URI.path) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }
}
