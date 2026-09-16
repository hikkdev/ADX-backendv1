import { Prisma } from '../database';

/**
 * Decimal arithmetic, separated from the ORM.
 *
 * `Prisma.Decimal` is decimal.js re-exported under the client's namespace. It
 * is arbitrary-precision arithmetic, not query-building — a service that adds
 * two rupee amounts with it is no more coupled to the ORM than one that uses
 * `Math.max`.
 *
 * The repository rule in .dependency-cruiser.cjs exists to keep queries behind
 * a port, and it is right to. This module is the seam that lets a service do
 * money arithmetic without importing the client to get it, rather than every
 * service reaching past the rule or pushing arithmetic into repositories where
 * it does not belong.
 *
 * Reach for `Decimal` whenever money is involved. JavaScript numbers are binary
 * floats: 0.1 + 0.2 is not 0.3, and a rate that drifts by a paisa decides
 * whether a publisher is told their price is too high.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/** A money value on the wire. Always a string, always two decimal places. */
export type Money = string;

/** Two decimal places, always — `"1200"` and `"1200.5"` are the same money. */
export const money = (value: Decimal | number | string): Money =>
  new Decimal(value).toFixed(2);

export const ZERO = new Decimal(0);
