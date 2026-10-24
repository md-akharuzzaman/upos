'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineTotals, priceBasket, normaliseBasket, settlePayment, roundHalfUp } = require('../src/domain/pricing');
const { hashPassword, verifyPassword, validatePassword, signToken, verifyToken } = require('../src/domain/auth');

test('line tax is rounded half-up per line (13 % HST)', () => {
  assert.deepEqual(lineTotals(245, 1, 1300), { subtotal: 245, tax: 32, total: 277 }); // 31.85 -> 32
  assert.deepEqual(lineTotals(250, 2, 1300), { subtotal: 500, tax: 65, total: 565 });
  assert.deepEqual(lineTotals(325, 3, 0), { subtotal: 975, tax: 0, total: 975 });
  assert.equal(roundHalfUp(0.5), 1);
  assert.equal(roundHalfUp(-0.5), -1);
});

test('basket totals add up across mixed tax rates', () => {
  const p = (id, priceCents, taxRateBp) => ({ id, sku: id.toUpperCase(), name: id, priceCents, taxRateBp });
  const b = priceBasket([
    { product: p('coffee', 245, 1300), qty: 2 },
    { product: p('muffin', 295, 0), qty: 1 },
  ]);
  assert.equal(b.subtotalCents, 785);
  assert.equal(b.taxCents, 64); // 490 * 13 % = 63.7 -> 64
  assert.equal(b.totalCents, 849);
  assert.deepEqual(b.lines.map((l) => l.lineNo), [1, 2]);
});

test('basket input is validated and duplicate products merged', () => {
  assert.deepEqual(normaliseBasket([{ productId: 'a', qty: 1 }, { productId: 'a', qty: 2 }]), [{ productId: 'a', qty: 3 }]);
  assert.throws(() => normaliseBasket([]), /non-empty/);
  assert.throws(() => normaliseBasket([{ productId: 'a', qty: 0 }]), /qty/);
  assert.throws(() => normaliseBasket([{ productId: 'a', qty: 1.5 }]), /qty/);
  assert.throws(() => normaliseBasket([{ productId: 'a', qty: 600 }, { productId: 'a', qty: 600 }]), /at most/);
});

test('cash payment computes change; card needs a terminal reference only', () => {
  assert.deepEqual(settlePayment({ method: 'cash', tenderedCents: 1000 }, 849), {
    method: 'cash',
    tenderedCents: 1000,
    changeCents: 151,
    reference: null,
    cardReference: null,
    brand: null,
  });
  assert.throws(() => settlePayment({ method: 'cash', tenderedCents: 800 }, 849), />= total/);
  assert.equal(settlePayment({ method: 'card', reference: 'AUTH-7731' }, 849).cardReference, 'AUTH-7731');
  assert.throws(() => settlePayment({ method: 'card', reference: '4111 1111 1111 1111' }, 849), /reference/);
  assert.throws(() => settlePayment({ method: 'bitcoin' }, 1), /payment.method/);
});

test('passwords are salted scrypt hashes', () => {
  const h1 = hashPassword('Password123');
  const h2 = hashPassword('Password123');
  assert.notEqual(h1, h2);
  assert.ok(verifyPassword('Password123', h1));
  assert.ok(!verifyPassword('Password124', h1));
  assert.match(validatePassword('short1'), /10-128/);
  assert.match(validatePassword('onlyletterslong'), /digits/);
  assert.equal(validatePassword('Password123'), null);
});

test('tokens are signed, tamper-proof and expire after 8 hours', () => {
  const key = 'k'.repeat(48);
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  const tok = signToken({ sid: 's', uid: 'u', role: 'cashier' }, key, t0);
  assert.equal(verifyToken(tok, key, t0).role, 'cashier');
  assert.equal(verifyToken(tok, 'other-key', t0), null);
  const [p, s] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'manager' })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${s}`, key, t0), null);
  assert.equal(verifyToken(tok, key, t0 + 8 * 3600 * 1000 + 1000), null);
});
