'use strict';

// Local-development demo data (memory store only; never runs in Azure).
const crypto = require('node:crypto');
const { hashPassword } = require('./domain/auth');

const PRODUCTS = [
  ['COF-001', 'Coffee, medium', 'Drinks', 245, 1300, 500],
  ['COF-002', 'Latte, large', 'Drinks', 475, 1300, 300],
  ['TEA-001', 'Green tea', 'Drinks', 225, 1300, 200],
  ['BAK-001', 'Butter croissant', 'Bakery', 325, 0, 60],
  ['BAK-002', 'Blueberry muffin', 'Bakery', 295, 0, 48],
  ['SNK-001', 'Granola bar', 'Snacks', 199, 1300, 120],
  ['SNK-002', 'Kettle chips', 'Snacks', 249, 1300, 80],
  ['GRO-001', 'Bottled water 500 ml', 'Drinks', 179, 1300, 240],
];

async function seedDemo(db) {
  if (await db.getStoreBySlug('demo')) return;
  const store = { id: crypto.randomUUID(), slug: 'demo', name: 'eURC Demo Café' };
  const pw = hashPassword('Password123');
  await db.createStore({ store, manager: { id: crypto.randomUUID(), email: 'manager@demo.test', name: 'Maya Manager', role: 'manager', passwordHash: pw } });
  await db.createUser(store.id, { id: crypto.randomUUID(), email: 'cashier@demo.test', name: 'Cal Cashier', role: 'cashier', passwordHash: pw });
  for (const [sku, name, category, priceCents, taxRateBp, stock] of PRODUCTS) {
    await db.createProduct(store.id, { id: crypto.randomUUID(), sku, name, category, priceCents, taxRateBp, stock });
  }
}

module.exports = { seedDemo };
