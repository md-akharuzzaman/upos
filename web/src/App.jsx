import { useCallback, useEffect, useState } from 'react';
import { api, session } from './api.js';
import Login from './components/Login.jsx';
import Register from './components/Register.jsx';
import Products from './components/Products.jsx';
import Sales from './components/Sales.jsx';
import Report from './components/Report.jsx';
import Team from './components/Team.jsx';
import Promotions from './components/Promotions.jsx';
import Business from './components/Business.jsx';
import TaxReport from './components/TaxReport.jsx';
import { can, ROLE_LABELS } from './lib/permissions.js';

// Each screen needs one permission (lib/permissions.js; the API checks again).
const TABS = [
  { id: 'register', label: 'Register', permission: 'sales.create' },
  { id: 'sales', label: 'Sales', permission: 'sales.view' },
  { id: 'products', label: 'Products', permission: 'products.manage' },
  { id: 'promotions', label: 'Promotions', permission: 'promotions.manage' },
  { id: 'report', label: 'Report', permission: 'reports.view' },
  { id: 'tax', label: 'GST/HST', permission: 'reports.tax' },
  { id: 'team', label: 'Staff', permission: 'staff.manage' },
  { id: 'business', label: 'Business', permission: 'business.profile' },
];

export default function App() {
  const [info, setInfo] = useState(null);
  const [s, setS] = useState(() => session.load());
  const [chosen, setTab] = useState('register');

  useEffect(() => {
    api('/api/info')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const signOut = useCallback(() => {
    session.clear();
    setS(null);
    setTab('register');
  }, []);

  const signedIn = (next) => {
    session.save(next);
    setS(next);
  };

  // Refresh the store (payment methods, business details) once per session:
  // an Admin may have changed them since this till signed in.
  const token = s?.token;
  useEffect(() => {
    if (!token) return;
    let live = true;
    api('/api/me', { token })
      .then((me) => {
        if (live && me?.store) {
          setS((cur) => {
            if (!cur || cur.token !== token) return cur;
            const next = { ...cur, store: { ...cur.store, ...me.store } };
            session.save(next);
            return next;
          });
        }
      })
      .catch(() => {}); // offline or an older API: keep the stored copy
    return () => {
      live = false;
    };
  }, [token]);

  const env = info?.environment;
  const tabs = s ? TABS.filter((t) => can(s.user, t.permission)) : [];
  // e.g. Customer support cannot use the register: open their first screen instead
  const tab = tabs.some((t) => t.id === chosen) ? chosen : tabs[0]?.id;
  return (
    <div className="app" data-env={env || 'local'}>
      <header className="topbar">
        <b className="brand">eURC</b>
        <span className="product">Point of Sale</span>
        {s && <span className="store">{s.store.name}</span>}
        <span className="spacer" />
        {info && (
          <span className="env" title={`${info.version} · ${info.commit}`} data-testid="env-badge">
            {env} · {info.slot} · v{info.version}
          </span>
        )}
        {s && (
          <span className="who">
            {s.user.name} ({ROLE_LABELS[s.user.role] || s.user.role})
            <button className="link light" onClick={signOut}>
              Sign out
            </button>
          </span>
        )}
      </header>
      {!s ? (
        <Login onSignedIn={signedIn} environment={env} />
      ) : (
        <>
          <nav className="tabs" aria-label="Sections">
            {tabs.map((t) => (
              <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <main>
            {tab === 'register' && <Register token={s.token} currency={s.store.currency} profile={s.store.profile} onAuthError={signOut} />}
            {tab === 'sales' && (
              <Sales
                token={s.token}
                currency={s.store.currency}
                canRefund={can(s.user, 'refunds.create')}
                canOverride={can(s.user, 'refunds.override')}
                onAuthError={signOut}
              />
            )}
            {tab === 'products' && (
              <Products token={s.token} currency={s.store.currency} canEditCategories={can(s.user, 'categories.manage')} onAuthError={signOut} />
            )}
            {tab === 'report' && <Report token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'tax' && <TaxReport token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'promotions' && <Promotions token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'team' && (
              <Team
                token={s.token}
                me={s.user}
                store={s.store}
                canEditPolicy={can(s.user, 'store.settings')}
                onStoreChange={(store) => signedIn({ ...s, store })}
                onAuthError={signOut}
              />
            )}
            {tab === 'business' && (
              <Business token={s.token} onStoreChange={(store) => signedIn({ ...s, store: { ...s.store, ...store } })} onAuthError={signOut} />
            )}
          </main>
        </>
      )}
      <footer className="foot">eURC POS · {info ? `${info.version} (${info.commit}) · ${info.region}` : 'offline'} · delivered by GitHub Actions</footer>
    </div>
  );
}
