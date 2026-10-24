// Color parsing, formatting and OKLCH-based adjustments.

export interface Color {
  r: number; // 0..1, sRGB
  g: number;
  b: number;
  a: number;
}

export function parseHex(hex: string): Color | undefined {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) {
    return undefined;
  }
  let h = m[1];
  if (h.length <= 4) {
    h = [...h].map((c) => c + c).join("");
  }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function toHex(c: Color): string {
  const x = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${x(c.r)}${x(c.g)}${x(c.b)}${c.a < 1 ? x(c.a) : ""}`;
}

// OKLab / OKLCH, see https://bottosson.github.io/posts/oklab/
interface Lab { L: number; a: number; b: number }
interface Lch { L: number; C: number; h: number }

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToLab(c: Color): Lab {
  const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function labToRgb(lab: Lab, alpha: number): Color {
  const l = (lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

const toLch = (lab: Lab): Lch => ({
  L: lab.L,
  C: Math.hypot(lab.a, lab.b),
  h: (Math.atan2(lab.b, lab.a) * 180) / Math.PI,
});

const inGamut = (c: Color) =>
  [c.r, c.g, c.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);

// Converts back to sRGB, reducing chroma until the color fits the gamut.
function lchToRgb(lch: Lch, alpha: number): Color {
  const L = Math.min(1, Math.max(0, lch.L));
  const rad = (lch.h * Math.PI) / 180;
  const at = (C: number) => labToRgb({ L, a: C * Math.cos(rad), b: C * Math.sin(rad) }, alpha);
  let c = at(lch.C);
  if (inGamut(c)) {
    return c;
  }
  let lo = 0, hi = lch.C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return at(lo);
}

function adjustLch(c: Color, f: (lch: Lch) => Lch): Color {
  return lchToRgb(f(toLch(rgbToLab(c))), c.a);
}

/** Perceptual lightness, 0 (black) to 1 (white). */
export const lightness = (c: Color) => rgbToLab(c).L;

export const lighten =(c: Color, amount: number) => adjustLch(c, (x) => ({ ...x, L: x.L + amount }));
export const darken = (c: Color, amount: number) => lighten(c, -amount);
export const saturate = (c: Color, amount: number) => adjustLch(c, (x) => ({ ...x, C: Math.max(0, x.C * (1 + amount)) }));
export const desaturate = (c: Color, amount: number) => saturate(c, -amount);
export const rotateHue = (c: Color, degrees: number) => adjustLch(c, (x) => ({ ...x, h: x.h + degrees }));
export const withAlpha = (c: Color, alpha: number): Color => ({ ...c, a: Math.min(1, Math.max(0, alpha)) });

/** Below this chroma a color is close to gray: its hue is meaningless and ratios explode. */
const NEAR_GRAY = 0.02;

export interface Offset {
  /** Lightness change, as a fraction of the room the base had in that direction (toward white or black). */
  fL: number;
  /** Absolute lightness change, for display. */
  dL: number;
  /** Chroma ratio, or an absolute change (ratio undefined) when the base is near gray. */
  ratio?: number;
  dC: number;
  /** Hue rotation in degrees, 0 when base or target is near gray. */
  dh: number;
  dA: number;
}

/** The OKLCH change that turns base into target. */
export function measureOffset(base: Color, target: Color): Offset {
  const b = toLch(rgbToLab(base));
  const t = toLch(rgbToLab(target));
  const gray = b.C < NEAR_GRAY || t.C < NEAR_GRAY;
  const dL = t.L - b.L;
  const room = dL >= 0 ? 1 - b.L : b.L;
  return {
    fL: room > 1e-6 ? dL / room : 0,
    dL,
    ratio: b.C < NEAR_GRAY ? undefined : t.C / b.C,
    dC: t.C - b.C,
    dh: gray ? 0 : ((((t.h - b.h) % 360) + 540) % 360) - 180,
    dA: target.a - base.a,
  };
}

/**
 * Applies the change from base to target to c; invertLightness flips the lightness direction.
 * Lightness moves the same fraction of the remaining room, so a light color can't overshoot white.
 */
export function applyOffset(c: Color, o: Offset, invertLightness = false): Color {
  return adjustLch(withAlpha(c, c.a + o.dA), (x) => ({
    L: (() => {
      const up = (o.fL >= 0) !== invertLightness;
      return up ? x.L + Math.abs(o.fL) * (1 - x.L) : x.L - Math.abs(o.fL) * x.L;
    })(),
    C: Math.max(0, o.ratio === undefined ? x.C + o.dC : x.C * o.ratio),
    h: x.h + o.dh,
  }));
}

export function mix(a: Color, b: Color, t: number): Color {
  const x = rgbToLab(a), y = rgbToLab(b);
  const k = (p: number, q: number) => p + (q - p) * t;
  return labToRgb({ L: k(x.L, y.L), a: k(x.a, y.a), b: k(x.b, y.b) }, k(a.a, b.a));
}
