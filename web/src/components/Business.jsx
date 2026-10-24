import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useLoader } from '../lib/useLoader.js';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const METHODS = [
  ['cash', 'Cash'],
  ['debit', 'Debit (Interac)'],
  ['credit', 'Credit card'],
  ['etransfer', 'Interac e-Transfer'],
  ['stripe', 'Stripe'],
];
const ZONES = [
  'America/St_Johns',
  'America/Halifax',
  'America/Toronto',
  'America/Winnipeg',
  'America/Regina',
  'America/Edmonton',
  'America/Vancouver',
  'America/Whitehorse',
];

function fromStore(st) {
  const p = st?.profile || {};
  const a = p.address || {};
  return {
    storeName: st?.name || '',
    legalName: p.legalName || '',
    storeType: p.storeType || '',
    timeZone: p.timeZone || 'America/Toronto',
    line1: a.line1 || '',
    line2: a.line2 || '',
    city: a.city || '',
    province: a.province || 'ON',
    postalCode: a.postalCode || '',
    phone: p.phone || '',
    email: p.email || '',
    website: p.website || '',
    gstHstNumber: p.gstHstNumber || '',
    pstNumber: p.pstNumber || '',
    qstNumber: p.qstNumber || '',
    paymentMethods: p.paymentMethods || ['cash', 'debit', 'credit'],
    etransferEmail: p.etransferEmail || '',
    stripeAccountId: p.stripeAccountId || '',
  };
}

// Admin only: the business details printed on receipts and used by tax reports.
export default function Business({ token, onStoreChange, onAuthError }) {
  const fetchProfile = useCallback(() => api('/api/store/profile', { token }), [token]);
  const [data, reload, loadError] = useLoader(fetchProfile, onAuthError, null);
  if (!data) return <section className="page">{loadError ? <p className="error">{loadError}</p> : <p className="muted">Loading…</p>}</section>;
  return <BusinessForm data={data} token={token} onStoreChange={onStoreChange} reload={reload} />;
}

function BusinessForm({ data, token, onStoreChange, reload }) {
  const [f, setF] = useState(() => fromStore(data));
  const [bank, setBank] = useState(null); // null = keep current
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (m) => setF({ ...f, paymentMethods: f.paymentMethods.includes(m) ? f.paymentMethods.filter((x) => x !== m) : [...f.paymentMethods, m] });

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    const body = {
      storeName: f.storeName,
      legalName: f.legalName || null,
      storeType: f.storeType || null,
      timeZone: f.timeZone,
      address: { line1: f.line1, line2: f.line2, city: f.city, province: f.province, postalCode: f.postalCode },
      phone: f.phone || null,
      email: f.email || null,
      website: f.website || null,
      gstHstNumber: f.gstHstNumber || null,
      pstNumber: f.pstNumber || null,
      qstNumber: f.qstNumber || null,
      paymentMethods: f.paymentMethods,
      etransferEmail: f.etransferEmail || null,
      stripeAccountId: f.stripeAccountId || null,
    };
    if (bank) body.bank = bank;
    try {
      const st = await api('/api/store/profile', { method: 'PUT', token, body });
      setBank(null);
      setSaved('Business profile saved.');
      onStoreChange?.(st);
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function suggest() {
    setError('');
    try {
      const r = await api('/api/categories/suggested', { method: 'POST', token, body: { storeType: f.storeType } });
      setSaved(`${r.created} starter categories added for this store type.`);
    } catch (err) {
      setError(err.message);
    }
  }

  const b = data.profile?.bank;
  return (
    <section className="page">
      <h2>Business profile</h2>
      <form className="card form-grid" onSubmit={save} aria-label="Business profile">
        <fieldset>
          <legend>Business</legend>
          <label>
            Store name (on screen)
            <input value={f.storeName} onChange={set('storeName')} required minLength={2} />
          </label>
          <label>
            Legal name (on receipts)
            <input value={f.legalName} onChange={set('legalName')} placeholder="e.g. Big Mart Retail Inc." />
          </label>
          <label>
            Store type
            <select value={f.storeType} onChange={set('storeType')}>
              <option value="">— choose —</option>
              {data.storeTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={suggest} disabled={!f.storeType}>
            Add starter categories for this type
          </button>
          <label>
            Time zone
            <select value={f.timeZone} onChange={set('timeZone')}>
              {ZONES.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Address and contact</legend>
          <label className="wide">
            Street address
            <input value={f.line1} onChange={set('line1')} />
          </label>
          <label className="wide">
            Unit / suite
            <input value={f.line2} onChange={set('line2')} />
          </label>
          <label>
            City
            <input value={f.city} onChange={set('city')} />
          </label>
          <label>
            Province
            <select value={f.province} onChange={set('province')}>
              {PROVINCES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Postal code
            <input value={f.postalCode} onChange={set('postalCode')} placeholder="A1A 1A1" />
          </label>
          <label>
            Phone
            <input value={f.phone} onChange={set('phone')} inputMode="tel" />
          </label>
          <label>
            E-mail
            <input value={f.email} onChange={set('email')} type="email" />
          </label>
          <label>
            Website
            <input value={f.website} onChange={set('website')} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Sales tax registration</legend>
          <label>
            GST/HST number
            <input value={f.gstHstNumber} onChange={set('gstHstNumber')} placeholder="123456789 RT0001" />
          </label>
          <label>
            PST number (BC, SK, MB)
            <input value={f.pstNumber} onChange={set('pstNumber')} />
          </label>
          <label>
            QST number (Québec)
            <input value={f.qstNumber} onChange={set('qstNumber')} placeholder="1234567890 TQ0001" />
          </label>
          <p className="hint wide">
            GST and HST share one Canada Revenue Agency registration: your 9-digit business number + RT + 4 digits. It is printed on every receipt.
          </p>
        </fieldset>
        <fieldset>
          <legend>Payment methods accepted</legend>
          {METHODS.map(([m, label]) => (
            <label className="check" key={m}>
              <input type="checkbox" checked={f.paymentMethods.includes(m)} onChange={() => toggle(m)} /> {label}
            </label>
          ))}
          {f.paymentMethods.includes('etransfer') && (
            <label>
              e-Transfer e-mail
              <input value={f.etransferEmail} onChange={set('etransferEmail')} type="email" required />
            </label>
          )}
          {f.paymentMethods.includes('stripe') && (
            <label>
              Stripe account ID
              <input value={f.stripeAccountId} onChange={set('stripeAccountId')} placeholder="acct_…" />
            </label>
          )}
          <p className="hint wide">Cards are taken on your payment terminal or Stripe; the POS records the approval code only and never sees card numbers.</p>
        </fieldset>
        <fieldset>
          <legend>Bank account for deposits</legend>
          {b && !bank && (
            <p className="wide" data-testid="bank-masked">
              {b.bankName} · {b.accountName} · institution {b.institution} · transit {b.transit} · account {b.account}
            </p>
          )}
          {!bank ? (
            <button type="button" onClick={() => setBank({ bankName: '', accountName: '', institutionNumber: '', transitNumber: '', accountNumber: '' })}>
              {b ? 'Replace bank details' : 'Add bank details'}
            </button>
          ) : (
            <>
              {[
                ['bankName', 'Bank'],
                ['accountName', 'Account name'],
                ['institutionNumber', 'Institution (3 digits)'],
                ['transitNumber', 'Transit (5 digits)'],
                ['accountNumber', 'Account number'],
              ].map(([k, label]) => (
                <label key={k}>
                  {label}
                  <input value={bank[k]} onChange={(e) => setBank({ ...bank, [k]: e.target.value })} required autoComplete="off" />
                </label>
              ))}
              <button type="button" className="link" onClick={() => setBank(null)}>
                Keep current details
              </button>
            </>
          )}
          <p className="hint wide">Bank numbers are stored encrypted in Azure Key Vault; screens and reports only ever show the last digits.</p>
        </fieldset>
        {error && (
          <p className="error wide" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="ok wide" role="status">
            {saved}
          </p>
        )}
        <div className="actions wide">
          <button className="primary">Save business profile</button>
        </div>
      </form>
    </section>
  );
}
