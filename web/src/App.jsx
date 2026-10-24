import { useCallback, useEffect, useState } from 'react';
import { api, session } from './api.js';
import Login from './components/Login.jsx';
import Register from './components/Register.jsx';
import Products from './components/Products.jsx';
import Sales from './components/Sales.jsx';
import Report from './components/Report.jsx';
import Team from './components/Team.jsx';

const TABS = [
  { id: 'register', label: 'Register' },
  { id: 'sales', label: 'Sales' },
  { id: 'products', label: 'Products', manager: true },
  { id: 'report', label: 'Report', manager: true },
  { id: 'team', label: 'Staff', manager: true },
];

export default function App() {
  const [info, setInfo] = useState(null);
  const [s, setS] = useState(() => session.load());
  const [tab, setTab] = useState('register');

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

  const env = info?.environment;
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
            {s.user.name} ({s.user.role})
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
            {TABS.filter((t) => !t.manager || s.user.role === 'manager').map((t) => (
              <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <main>
            {tab === 'register' && <Register token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'sales' && <Sales token={s.token} currency={s.store.currency} isManager={s.user.role === 'manager'} onAuthError={signOut} />}
            {tab === 'products' && <Products token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'report' && <Report token={s.token} currency={s.store.currency} onAuthError={signOut} />}
            {tab === 'team' && <Team token={s.token} me={s.user} onAuthError={signOut} />}
          </main>
        </>
      )}
      <footer className="foot">
        eURC POS · {info ? `${info.version} (${info.commit}) · ${info.region}` : 'offline'} · delivered by GitHub Actions
      </footer>
    </div>
  );
}
