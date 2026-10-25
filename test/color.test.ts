import "./fake-vscode";
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { applyOffset, distance, measureOffset, parseHex, shiftHue, toHex } from "../src/color";

const hex = (s: string) => parseHex(s)!;

describe("hex", () => {
  it("round-trips, with and without alpha, short forms expanded", () => {
    for (const s of ["#4EC9B0", "#00000080", "#FFFFFF"]) assert.equal(toHex(hex(s)), s);
    assert.equal(toHex(hex("#abc")), "#AABBCC");
    assert.equal(parseHex("#12"), undefined);
  });
});

describe("offset", () => {
  it("is exact where the color equals the base", () => {
    const o = measureOffset(hex("#4EC9B0"), hex("#86C691"));
    assert.equal(toHex(applyOffset(hex("#4EC9B0"), o)), "#86C691");
  });

  it("flips lightness when asked", () => {
    const o = measureOffset(hex("#4EC9B0"), hex("#86C691"));
    const dark = applyOffset(hex("#267F99"), o);
    const light = applyOffset(hex("#267F99"), o, true);
    assert.notEqual(toHex(dark), toHex(light));
  });
});

describe("hue by visible distance", () => {
  it("moves a vivid and a muted color by the same visible amount", () => {
    for (const c of ["#4EC9B0", "#8FA39F", "#DCDCAA"]) {
      const { color, capped } = shiftHue(hex(c), 0.03);
      assert.equal(capped, false, c);
      assert.ok(Math.abs(distance(hex(c), color) - 0.03) < 0.003, `${c}: moved ${distance(hex(c), color)}`);
    }
  });

  it("caps where a color is too gray to move that far", () => {
    assert.equal(shiftHue(hex("#808081"), 0.2).capped, true);
  });
});
