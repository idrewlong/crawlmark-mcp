/**
 * Expected organic CTR by Google position (fractions, 0.28 = 28%).
 *
 * EDITABLE: this is an industry-average approximation, not a measurement of any
 * one site. CTR varies a lot by query intent, SERP features and device, so treat
 * the "estimated extra clicks" built on it as a ranking signal for where to look,
 * not a forecast. Tune the numbers below to match your own data.
 */
export const CTR_BY_POSITION: Readonly<Record<number, number>> = {
  1: 0.28,
  2: 0.15,
  3: 0.1,
  4: 0.07,
  5: 0.05,
  6: 0.04,
  7: 0.035,
  8: 0.03,
  9: 0.025,
  10: 0.02,
  // 11-20 are all about 1%.
  11: 0.01,
  12: 0.01,
  13: 0.01,
  14: 0.01,
  15: 0.01,
  16: 0.01,
  17: 0.01,
  18: 0.01,
  19: 0.01,
  20: 0.01,
};

/** Used for positions beyond 20 (page 3 and further). */
export const CTR_BEYOND_20 = 0.005;

/**
 * Expected CTR (fraction) at a possibly fractional average position: rounded to
 * the nearest whole position, positions below 1 treated as 1, above 20 using CTR_BEYOND_20.
 */
export function expectedCtr(position: number): number {
  if (!Number.isFinite(position)) return CTR_BEYOND_20;
  const p = Math.max(1, Math.round(position));
  return CTR_BY_POSITION[p] ?? CTR_BEYOND_20;
}
