import { describe, expect, it } from 'vitest';
import { bestPromotion, cartTotals, formatMoney, lineTotals, parseMoney, quickTenders } from './money.js';

describe('money (must match app/src/domain/pricing.js)', () => {
  it('rounds line tax half-up like the API', () => {
    expect(lineTotals(245, 1, 1300)).toEqual({ subtotal: 245, tax: 32, total: 277 });
    expect(lineTotals(245, 2, 1300).tax).toBe(64);
  });
  it('totals a mixed-tax cart', () => {
    const p = (priceCents, taxRateBp) => ({ priceCents, taxRateBp });
    expect(cartTotals([{ product: p(245, 1300), qty: 2 }, { product: p(295, 0), qty: 1 }])).toEqual({ subtotal: 785, tax: 64, discount: 0, total: 849, items: 3 });
  });
  it('applies the best running promotion per line, then tax on the discounted price (matches the API test)', () => {
    const tea = { sku: 'TEA', category: 'General', priceCents: 250, taxRateBp: 1300 };
    const day = 86400000;
    const promos = [
      { name: '20 % off', kind: 'percent', value: 2000, target: 'all', startsAt: new Date(Date.now() - day).toISOString(), endsAt: null },
      { name: 'Ended', kind: 'amount', value: 200, target: 'all', startsAt: new Date(Date.now() - 2 * day).toISOString(), endsAt: new Date(Date.now() - day).toISOString() },
    ];
    expect(cartTotals([{ product: tea, qty: 3 }], promos)).toEqual({ subtotal: 600, tax: 78, discount: 150, total: 678, items: 3 });
    expect(bestPromotion(tea, promos).promotion.name).toBe('20 % off');
    expect(bestPromotion({ ...tea, priceCents: 100 }, [{ ...promos[0], kind: 'amount', value: 500 }]).unitDiscountCents).toBe(100);
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
