// Color functions and evaluation of color expressions.

import { Expr, Flag, matchesPattern, NumUnit, Range } from "./cfg";
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

// Argument kinds; numbers keep their unit until they reach a function, which checks and converts:
//   amount   10% or 0.1                   (percent converts to a factor)
//   angle    30, 30deg or 30°             (degrees; % is an error)
//   channel  0-255, 0.0-1.0 or 0%-100%    (integers vs decimals decide the scale)
//   alpha    0.5, 50%, or 0-255
type ArgKind = "color" | "amount" | "angle" | "channel" | "alpha";

interface Num {
  num: number;
  unit: NumUnit;
  decimal: boolean;
}

const isNum = (v: Color | Num): v is Num => "num" in v;

const KIND_TEXT: Record<ArgKind, string> = {
  color: "a color",
  amount: "an amount like 10% or 0.1",
  angle: "an angle in degrees like 30",
  channel: "a channel value: 0-255, 0.0-1.0 or a percentage",
  alpha: "an opacity like 0.5 or 50%",
};

export const FUNCTIONS: Record<
  string,
  { sig: ArgKind[]; optional?: number; fn: (...a: any[]) => Color; contextual?: boolean }
> = {
  emphasize: { sig: ["color", "amount"], optional: 1, contextual: true, fn: emphasize },
  soften: { sig: ["color", "amount"], optional: 1, contextual: true, fn: (ctx, c, amount = 0.1) => emphasize(ctx, c, -amount) },
  rgb: { sig: ["channel", "channel", "channel", "alpha"], optional: 1, fn: (r, g, b, a = 1) => ({ r, g, b, a }) },
  lighten: { sig: ["color", "amount"], fn: color.lighten },
  darken: { sig: ["color", "amount"], fn: color.darken },
  saturate: { sig: ["color", "amount"], fn: color.saturate },
  desaturate: { sig: ["color", "amount"], fn: color.desaturate },
  hue: { sig: ["color", "angle"], fn: color.rotateHue },
  alpha: { sig: ["color", "alpha"], fn: color.withAlpha },
  mix: { sig: ["color", "color", "amount"], optional: 1, fn: (a, b, t = 0.5) => color.mix(a, b, t) },
};
FUNCTIONS.rgba = FUNCTIONS.rgb;

/** Converts a number argument to what the function expects, or explains why it doesn't fit. */
function convert(n: Num, kind: ArgKind, fn: string, range: Range): number {
  const wrong = (why: string) => new EvalError(`${fn}() expects ${KIND_TEXT[kind]}${why}`, range);
  switch (kind) {
    case "amount":
      if (n.unit === "deg") throw wrong(", not an angle");
      return n.unit === "percent" ? n.num / 100 : n.num;
    case "angle":
      if (n.unit === "percent") throw wrong(", not a percentage");
      return n.num;
    case "alpha":
      if (n.unit === "deg") throw wrong(", not an angle");
      if (n.unit === "percent") return n.num / 100;
      return n.num > 1 ? n.num / 255 : n.num;
    case "channel":
      if (n.unit === "deg") throw wrong(", not an angle");
      if (n.unit === "percent") return n.num / 100;
      if (n.decimal && n.num > 1) throw wrong("; decimals are 0.0-1.0, use integers for 0-255");
      if (!n.decimal && n.num > 255) throw wrong("; integers are 0-255");
      return n.decimal ? n.num : n.num / 255;
    case "color":
      throw wrong(", not a number");
  }
}

/** rgb(0, 100, 200) is 0-255 and rgb(0.5, 1.0, 0.2) is 0-1; mixing the two is almost always a mistake. */
function checkChannelScale(args: { v: Color | Num; range: Range }[], fn: string) {
  const plain = args.slice(0, 3).filter((a) => isNum(a.v) && a.v.unit === "none" && a.v.num !== 0);
  const decimal = plain.find((a) => (a.v as Num).decimal);
  const integer = plain.find((a) => !(a.v as Num).decimal);
  if (decimal && integer) {
    throw new EvalError(
      `${fn}() mixes 0-255 and 0.0-1.0 values; write all channels as integers (0-255) or all with a decimal point (0.0-1.0)`,
      decimal.range,
    );
  }
}

function evalArg(e: Expr, ctx: EvalContext): Color | Num {
  switch (e.kind) {
    case "color":
      return e.value;
    case "num":
      return { num: e.value, unit: e.unit, decimal: e.decimal };
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
      const raw = e.args.map((a) => ({ v: evalArg(a, ctx), range: a.range }));
      if (f.sig[0] === "channel") checkChannelScale(raw, e.fn);
      const args = raw.map(({ v, range }, i) => {
        const kind = f.sig[i];
        if (!isNum(v)) {
          if (kind !== "color") throw new EvalError(`${e.fn}() argument ${i + 1} expects ${KIND_TEXT[kind]}, not a color`, range);
          return v;
        }
        return convert(v, kind, e.fn, range);
      });
      return f.contextual ? f.fn(ctx, ...args) : f.fn(...args);
    }
  }
}

export function evaluateColor(e: Expr, ctx: EvalContext): Color {
  const v = evalArg(e, ctx);
  if (isNum(v)) throw new EvalError("Expected a color, not a number", e.range);
  return v;
}
