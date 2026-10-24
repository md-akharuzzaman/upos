// Payment methods as the register shows them (v2.4). Mirrors
// app/src/domain/payments.js; the API checks everything again.
export const DEFAULT_METHODS = ['cash', 'debit', 'credit'];

export const LABELS = {
  cash: 'Cash',
  debit: 'Debit',
  credit: 'Credit',
  card: 'Card',
  etransfer: 'e-Transfer',
  stripe: 'Stripe',
};

// Longer names for receipts and reports
export const LONG_LABELS = {
  cash: 'Cash',
  debit: 'Debit (Interac)',
  credit: 'Credit card',
  card: 'Card',
  etransfer: 'Interac e-Transfer',
  stripe: 'Stripe',
};

export const CARD_BRANDS = [
  ['visa', 'Visa'],
  ['mastercard', 'Mastercard'],
  ['amex', 'American Express'],
  ['discover', 'Discover'],
  ['unionpay', 'UnionPay'],
  ['jcb', 'JCB'],
  ['other', 'Other'],
];

export const REFERENCE_RULES = {
  card: /^[A-Za-z0-9-]{4,40}$/,
  etransfer: /^[A-Za-z0-9]{6,40}$/,
  stripe: /^(pi|ch|py)_[A-Za-z0-9]{8,37}$/,
};

const isCard = (m) => m === 'debit' || m === 'credit' || m === 'card';

export function validReference(method, reference) {
  const rule = REFERENCE_RULES[isCard(method) ? 'card' : method];
  return Boolean(rule && rule.test(String(reference || '').trim()));
}

/** The methods the register offers: the store's accepted list (business profile), in a fixed order. */
export function offeredMethods(profile) {
  const list = Array.isArray(profile?.paymentMethods) && profile.paymentMethods.length ? profile.paymentMethods : DEFAULT_METHODS;
  return ['cash', 'debit', 'credit', 'etransfer', 'stripe'].filter((m) => list.includes(m));
}

/** "Credit card · Visa" / "Debit (Interac)" - how a receipt names the payment. */
export function paymentLabel(payment) {
  const base = LONG_LABELS[payment?.method] || payment?.method || '';
  const brand = payment?.method === 'credit' && payment.brand ? CARD_BRANDS.find(([id]) => id === payment.brand)?.[1] : null;
  return brand ? `${base} · ${brand}` : base;
}

/** What the person refunding has to do to give the money back. */
export function refundInstruction(payment) {
  const ref = payment?.reference ?? payment?.cardReference;
  switch (payment?.method) {
    case 'cash':
      return 'Give the customer this amount in cash from the drawer.';
    case 'etransfer':
      return `Send this amount back to the customer by Interac e-Transfer (original reference ${ref}).`;
    case 'stripe':
      return `Refund this amount in the Stripe dashboard (payment ${ref}).`;
    default:
      return `Reverse this amount on the card terminal (original approval ${ref}).`;
  }
}
