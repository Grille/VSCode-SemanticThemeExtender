// Color functions and evaluation of color expressions.

import { Expr, Flag, matchesPattern, Range } from "./cfg";
import * as color from "./color";
import { Color } from "./color";

export interface EvalContext {
  variable(name: string, range: Range): Color;
  ref(name: string, range: Range): Color;
  /** The theme's editor background, for contrast-aware functions. */
  background(): Color;
  flags: Set<Flag>;
  themeId: string;
}

export class EvalError extends Error {
  constructor(message: string, readonly range: Range) {
    super(message);
  }
}

/** A variable that (indirectly) refers to itself; passed through unchanged to its definition. */
export class CycleError extends EvalError {}

/** Thrown when no arm of a match applies to the active theme. */
export class NoMatch extends Error {}

// Away from / toward the background: lighter on dark themes, darker on light ones.
const onDark = (ctx: EvalContext) => color.lightness(ctx.background()) < 0.5;
const emphasize = (ctx: EvalContext, c: Color, amount = 0.1) =>
  onDark(ctx) ? color.lighten(c, amount) : color.darken(c, amount);

export const FUNCTIONS: Record<
  string,
  { sig: ("c" | "n")[]; optional?: number; fn: (...a: any[]) => Color; contextual?: boolean }
> = {
  emphasize: { sig: ["c", "n"], optional: 1, contextual: true, fn: emphasize },
  soften: { sig: ["c", "n"], optional: 1, contextual: true, fn: (ctx, c, amount = 0.1) => emphasize(ctx, c, -amount) },
  rgb: { sig: ["n", "n", "n", "n"], optional: 1, fn: (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a: a > 1 ? a / 255 : a }) },
  lighten: { sig: ["c", "n"], fn: color.lighten },
  darken: { sig: ["c", "n"], fn: color.darken },
  saturate: { sig: ["c", "n"], fn: color.saturate },
  desaturate: { sig: ["c", "n"], fn: color.desaturate },
  hue: { sig: ["c", "n"], fn: color.rotateHue },
  alpha: { sig: ["c", "n"], fn: color.withAlpha },
  mix: { sig: ["c", "c", "n"], optional: 1, fn: (a, b, t = 0.5) => color.mix(a, b, t) },
};
FUNCTIONS.rgba = FUNCTIONS.rgb;

function evalArg(e: Expr, ctx: EvalContext): Color | number {
  switch (e.kind) {
    case "color":
      return e.value;
    case "num":
      return e.value;
    case "var":
      return ctx.variable(e.name, e.range);
    case "ref":
      return ctx.ref(e.name, e.range);
    case "match": {
      const arm = e.arms.find((a) => matchesPattern(a.pattern, ctx.flags, ctx.themeId));
      if (!arm) throw new NoMatch();
      return evalArg(arm.body, ctx);
    }
    case "call": {
      const f = FUNCTIONS[e.fn];
      if (!f) throw new EvalError(`Unknown function '${e.fn}'`, e.nameRange);
      const min = f.sig.length - (f.optional ?? 0);
      if (e.args.length < min || e.args.length > f.sig.length) {
        throw new EvalError(`${e.fn}() takes ${min === f.sig.length ? min : `${min}-${f.sig.length}`} arguments`, e.range);
      }
      const args = e.args.map((a, i) => {
        const v = evalArg(a, ctx);
        const want = f.sig[i];
        if ((want === "n") !== (typeof v === "number")) {
          throw new EvalError(`${e.fn}() argument ${i + 1} must be a ${want === "n" ? "number" : "color"}`, a.range);
        }
        return v;
      });
      return f.contextual ? f.fn(ctx, ...args) : f.fn(...args);
    }
  }
}

export function evaluateColor(e: Expr, ctx: EvalContext): Color {
  const v = evalArg(e, ctx);
  if (typeof v === "number") throw new EvalError("Expected a color, not a number", e.range);
  return v;
}
