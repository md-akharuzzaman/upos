'use strict';

// Business profile (v2.3): what an Admin sets up once - legal details for
// receipts and tax reports, the store type, time zone and accepted payment
// methods. Bank details are kept in Key Vault; only a masked copy is stored.

const PAYMENT_METHODS = ['cash', 'debit', 'credit', 'etransfer', 'stripe'];
const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

const STORE_TYPES = [
  { id: 'coffee_shop', label: 'Coffee shop / café' },
  { id: 'restaurant', label: 'Restaurant' },
  { id: 'supermarket', label: 'Supermarket / grocery' },
  { id: 'convenience', label: 'Convenience store' },
  { id: 'clothing', label: 'Clothing / fashion' },
  { id: 'pharmacy', label: 'Pharmacy' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'general', label: 'General retail' },
];

// Starter categories per store type. finalSale: food and similar perishable or
// hygiene goods are not refundable by default (the store can change this).
const SUGGESTED = {
  coffee_shop: [
    { name: 'Drinks', finalSale: true, subcategories: ['Coffee', 'Tea', 'Cold drinks'] },
    { name: 'Food', finalSale: true, subcategories: ['Bakery', 'Sandwiches', 'Snacks'] },
    { name: 'Merchandise', subcategories: ['Mugs', 'Coffee beans'] },
  ],
  restaurant: [
    { name: 'Food', finalSale: true, subcategories: ['Starters', 'Mains', 'Desserts', 'Sides'] },
    { name: 'Drinks', finalSale: true, subcategories: ['Soft drinks', 'Hot drinks', 'Alcohol'] },
  ],
  supermarket: [
    { name: 'Food', finalSale: true, subcategories: ['Produce', 'Dairy', 'Bakery', 'Meat & seafood', 'Frozen', 'Pantry'] },
    { name: 'Beverages', finalSale: true, subcategories: ['Water', 'Juice', 'Soft drinks'] },
    { name: 'Household', subcategories: ['Cleaning', 'Paper goods'] },
    { name: 'Personal care', finalSale: true, subcategories: ['Health', 'Beauty'] },
  ],
  convenience: [
    { name: 'Food', finalSale: true, subcategories: ['Snacks', 'Candy', 'Ready to eat'] },
    { name: 'Drinks', finalSale: true, subcategories: ['Soft drinks', 'Energy drinks', 'Water'] },
    { name: 'Essentials', subcategories: ['Household', 'Personal care'] },
  ],
  clothing: [
    { name: 'Women', subcategories: ['Tops', 'Dresses', 'Pants', 'Outerwear'] },
    { name: 'Men', subcategories: ['Shirts', 'Pants', 'Outerwear'] },
    { name: 'Kids', subcategories: ['Tops', 'Bottoms'] },
    { name: 'Accessories', subcategories: ['Bags', 'Belts', 'Jewellery'] },
    { name: 'Underwear & swim', finalSale: true, subcategories: ['Underwear', 'Swimwear'] },
  ],
  pharmacy: [
    { name: 'Medicine', finalSale: true, subcategories: ['Pain relief', 'Cold & flu', 'Vitamins'] },
    { name: 'Personal care', finalSale: true, subcategories: ['Skin care', 'Oral care'] },
    { name: 'Baby', subcategories: ['Diapers', 'Formula'] },
  ],
  electronics: [
    { name: 'Phones & tablets', subcategories: ['Phones', 'Tablets', 'Accessories'] },
    { name: 'Computers', subcategories: ['Laptops', 'Peripherals'] },
    { name: 'Audio', subcategories: ['Headphones', 'Speakers'] },
  ],
  general: [
    { name: 'General', subcategories: [] },
    { name: 'Food', finalSale: true, subcategories: [] },
  ],
};

const suggestedCategories = (type) => SUGGESTED[type] || null;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}
const text = (v, name, max = 120) => {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw invalid(`${name} must be text of at most ${max} characters`);
  return v.trim();
};
const matching = (v, re, name, hint) => {
  const t = text(v, name);
  if (t == null) return t;
  const n = t.toUpperCase().replace(/\s+/g, '');
  if (!re.test(n)) throw invalid(`${name} ${hint}`);
  return n;
};

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Merges a profile update into the current profile (fields left out are kept). */
function profileInput(b, current = {}) {
  const out = { ...current };
  const set = (k, v) => {
    if (v !== undefined) out[k] = v;
  };
  set('legalName', text(b.legalName, 'legalName'));
  if (b.storeType !== undefined) {
    if (b.storeType !== null && !STORE_TYPES.some((t) => t.id === b.storeType))
      throw invalid(`storeType must be one of: ${STORE_TYPES.map((t) => t.id).join(', ')}`);
    out.storeType = b.storeType;
  }
  if (b.address !== undefined) {
    const a = b.address || {};
    const province = a.province ? String(a.province).toUpperCase() : null;
    if (province && !PROVINCES.includes(province)) throw invalid(`province must be one of: ${PROVINCES.join(', ')}`);
    out.address = {
      line1: text(a.line1, 'address line 1') ?? null,
      line2: text(a.line2, 'address line 2') ?? null,
      city: text(a.city, 'city', 60) ?? null,
      province,
      postalCode: a.postalCode ? matching(a.postalCode, /^[A-Z]\d[A-Z]\d[A-Z]\d$/, 'postalCode', 'must look like A1A 1A1') : null,
      country: 'CA',
    };
    if (out.address.postalCode) out.address.postalCode = `${out.address.postalCode.slice(0, 3)} ${out.address.postalCode.slice(3)}`;
  }
  set('phone', b.phone === undefined ? undefined : matching(b.phone, /^\+?[\d().-]{7,20}$/, 'phone', 'must be a phone number'));
  if (b.email !== undefined) {
    const e = text(b.email, 'email', 254);
    if (e && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw invalid('email must be an e-mail address');
    out.email = e ? e.toLowerCase() : null;
  }
  set('website', text(b.website, 'website', 200));
  // Canada Revenue Agency: one registration covers GST and HST - the 9-digit
  // business number + RT + 4-digit reference, e.g. 123456789 RT0001.
  set(
    'gstHstNumber',
    b.gstHstNumber === undefined
      ? undefined
      : matching(b.gstHstNumber, /^\d{9}RT\d{4}$/, 'gstHstNumber', 'must be 9 digits + RT + 4 digits, e.g. 123456789 RT0001'),
  );
  set('pstNumber', text(b.pstNumber, 'pstNumber', 30));
  set('qstNumber', b.qstNumber === undefined ? undefined : matching(b.qstNumber, /^\d{10}TQ\d{4}$/, 'qstNumber', 'must be 10 digits + TQ + 4 digits'));
  if (b.timeZone !== undefined) {
    if (!validTimeZone(b.timeZone)) throw invalid('timeZone must be an IANA time zone, e.g. America/Toronto');
    out.timeZone = b.timeZone;
  }
  if (b.paymentMethods !== undefined) {
    if (!Array.isArray(b.paymentMethods) || b.paymentMethods.length === 0 || b.paymentMethods.some((m) => !PAYMENT_METHODS.includes(m))) {
      throw invalid(`paymentMethods must list one or more of: ${PAYMENT_METHODS.join(', ')}`);
    }
    out.paymentMethods = PAYMENT_METHODS.filter((m) => b.paymentMethods.includes(m));
  }
  if (b.etransferEmail !== undefined) {
    const e = text(b.etransferEmail, 'etransferEmail', 254);
    if (e && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw invalid('etransferEmail must be an e-mail address');
    out.etransferEmail = e ? e.toLowerCase() : null;
  }
  set('stripeAccountId', b.stripeAccountId === undefined ? undefined : b.stripeAccountId ? matchingRaw(b.stripeAccountId) : null);
  if (out.paymentMethods?.includes('etransfer') && !out.etransferEmail) throw invalid('add the e-transfer e-mail to accept e-transfers');
  return out;
}

function matchingRaw(v) {
  const t = String(v).trim();
  if (!/^acct_[A-Za-z0-9]{8,32}$/.test(t)) throw invalid('stripeAccountId must look like acct_1A2b3C4d5E6f7G8h');
  return t;
}

/** Canadian bank account: institution (3) + transit (5) + account (7-12 digits). */
function bankInput(b) {
  const digits = (v, n, name) => {
    const s = String(v ?? '').replace(/\D/g, '');
    if (!n.test(s)) throw invalid(`${name} has the wrong number of digits`);
    return s;
  };
  const bankName = text(b.bankName, 'bankName', 80);
  const accountName = text(b.accountName, 'accountName', 120);
  if (!bankName || !accountName) throw invalid('bankName and accountName are required');
  const institution = digits(b.institutionNumber, /^\d{3}$/, 'institutionNumber (3)');
  const transit = digits(b.transitNumber, /^\d{5}$/, 'transitNumber (5)');
  const account = digits(b.accountNumber, /^\d{7,12}$/, 'accountNumber (7-12)');
  return {
    secret: { bankName, accountName, institution, transit, account },
    masked: { bankName, accountName, institution, transit: `•••${transit.slice(-2)}`, account: `••••${account.slice(-4)}` },
  };
}

const DEFAULTS = { timeZone: 'America/Toronto', paymentMethods: ['cash', 'debit', 'credit'], address: null, bank: null };

function publicProfile(p) {
  return { ...DEFAULTS, ...(p || {}) };
}

/** Today's date (YYYY-MM-DD) in the store's time zone. */
function storeToday(store, now = new Date()) {
  const tz = store?.profile?.timeZone || DEFAULTS.timeZone;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

module.exports = { PAYMENT_METHODS, PROVINCES, STORE_TYPES, suggestedCategories, profileInput, bankInput, publicProfile, storeToday };
