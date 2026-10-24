import { describe, expect, it } from 'vitest';
import { cartTotals, formatMoney, lineTotals, parseMoney, quickTenders } from './money.js';

describe('money (must match app/src/domain/pricing.js)', () => {
  it('rounds line tax half-up like the API', () => {
    expect(lineTotals(245, 1, 1300)).toEqual({ subtotal: 245, tax: 32, total: 277 });
    expect(lineTotals(245, 2, 1300).tax).toBe(64);
  });
  it('totals a mixed-tax cart', () => {
    const p = (priceCents, taxRateBp) => ({ priceCents, taxRateBp });
    expect(cartTotals([{ product: p(245, 1300), qty: 2 }, { product: p(295, 0), qty: 1 }])).toEqual({ subtotal: 785, tax: 64, total: 849, items: 3 });
  });
  it('parses cash input', () => {
    expect(parseMoney('10')).toBe(1000);
    expect(parseMoney('$12.5')).toBe(1250);
    expect(parseMoney('8.49')).toBe(849);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
  });
  it('suggests sensible quick-tender amounts', () => {
    expect(quickTenders(849)).toEqual([849, 1000, 2000, 5000, 10000]);
    expect(quickTenders(2000)).toEqual([2000, 5000, 10000]);
  });
  it('formats Canadian dollars', () => {
    expect(formatMoney(849)).toBe('$8.49');
  });
});
