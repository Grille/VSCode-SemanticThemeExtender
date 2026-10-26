import * as fs from "fs";
import * as path from "path";
import Mocha = require("mocha");

/** Called by VS Code in the test window: runs the *.test.js files next to this one. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 180_000 });
  const filter = process.env.TEST_FILTER;
  fs.readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.js") && (!filter || f.includes(filter)))
    .forEach((f) => mocha.addFile(path.join(__dirname, f)));
  return new Promise((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())));
}
