import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

// Runs test/vscode/*.test.ts inside a real VS Code, with the language extensions people use. All
// of it (VS Code, extensions, settings) lives in .vscode-test/, apart from your own installation.

const repo = path.resolve(__dirname, "..", "..", "..");
const cache = path.join(repo, ".vscode-test");
// Not in .vscode-test: C# Dev Kit's server paths are over 190 characters long by themselves, and
// past 260 in all Windows can't start them ("file not found").
const extensions = process.env.VSCODE_TEST_EXTENSIONS ?? path.join(os.tmpdir(), "stx-ext");

const EXTENSIONS = ["ms-python.vscode-pylance", "ms-dotnettools.csdevkit", "ms-toolsai.jupyter"];

const SETTINGS = {
  // Project rules only apply in trusted workspaces; the test window can't be asked.
  "security.workspace.trust.enabled": false,
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "extensions.ignoreRecommendations": true,
  "update.mode": "none",
  // C# Dev Kit can't open solutions in a test window ("Cannot find an instance of the
  // ...SolutionData service"); the C# extension loads the project itself then.
  "dotnet.preferCSharpExtension": true,
};

async function main() {
  const exe = await downloadAndUnzipVSCode({ version: "stable", cachePath: cache });
  const [cli, ...args] = [...resolveCliArgsFromVSCodeExecutablePath(exe).filter((a) => !a.startsWith("--extensions-dir")), `--extensions-dir=${extensions}`];
  const installed = fs.existsSync(extensions) ? fs.readdirSync(extensions) : [];
  for (const id of EXTENSIONS.filter((id) => !installed.some((d) => d.startsWith(`${id}-`)))) {
    // Installs what they depend on too: the Python extension, the C# extension.
    const r = spawnSync(cli, [...args, "--install-extension", id], { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error(`installing ${id} failed`);
  }
  const user = path.join(cache, "user-data", "User");
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, "settings.json"), JSON.stringify(SETTINGS, null, 2));

  // Set when this runs from a VS Code terminal or task; VS Code would start as plain Node then.
  delete process.env.ELECTRON_RUN_AS_NODE;
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: repo,
    extensionTestsPath: path.join(__dirname, "index.js"),
    extensionTestsEnv: { TEST_FILTER: process.argv[2] },
    launchArgs: [path.join(repo, "test", "fixtures", "projects", "projects.code-workspace"), "--disable-workspace-trust", `--extensions-dir=${extensions}`],
  });
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
