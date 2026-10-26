import { Slotted } from "./base";

function sealed(constructor: Function) {}

export class Child extends Slotted {}

export class GrandChild extends Child {}

@sealed
export class Point {
  x = 0;
  static make(): Point {
    return new Point();
  }
}

/** @deprecated use something else. */
export function handler(callback: (n: number) => string): void {
  callback(1);
}

export const x = new GrandChild(1);
