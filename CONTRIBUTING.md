# Contributing

Building the extension, and the three levels of tests.

```sh
npm install
npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

```sh
npm test
```

runs the tests in [test/](test/) with Node's test runner, against a fake `vscode` module
([test/fake-vscode.ts](test/fake-vscode.ts)): two small themes and a scripted language server
(tokens, symbols, hovers, definitions, type hierarchy) over in-memory files, so results don't
depend on what is installed.

```sh
npm run test:servers
```

runs the decorator against real language servers on the projects in
[test/fixtures/projects](test/fixtures/projects): basedpyright for Python (Pylance's license
doesn't allow running it outside VS Code; basedpyright shares its Pyright core but has no type
hierarchy), typescript-language-server, and the Roslyn server of an installed C# extension (run
`dotnet restore` in the C# fixture once). Suites whose server isn't installed are skipped. The
first part of each suite pins down what the server reports (token types, symbol ranges, hover
format), so a server update that changes an assumption fails there.

```sh
npm run test:vscode
```

runs [test/vscode/](test/vscode/) inside a real VS Code, with Pylance (also in a Jupyter
notebook), the C# extension, rust-analyzer and the built-in TypeScript support, on the same
projects: what you'd see with Inspect Token. It opens a
VS Code window for a few minutes. The first run downloads VS Code into `.vscode-test/` and the
extensions into a short folder in your temp directory (`VSCODE_TEST_EXTENSIONS` to change it;
C# Dev Kit's paths are too long for Windows otherwise). The Rust suite needs a Rust toolchain
([rustup](https://rustup.rs)) and is skipped without one. `npm run test:vscode -- csharp` runs
one file.

The list of UI color IDs and their defaults ([src/uiColors.ts](src/uiColors.ts)) is
generated from VS Code's own code, since VS Code has no API for it:

```sh
node scripts/generate-ui-colors.js "<VS Code install>/resources/app/out/vs/workbench/workbench.desktop.main.js"
```
