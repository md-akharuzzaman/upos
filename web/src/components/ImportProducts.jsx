import { useState } from 'react';
import { api } from '../api.js';
import { downloadProducts, readSheetFile, rowsToProducts } from '../lib/excel.js';

const BATCH = 1000; // rows per request; big files go in batches, each one transaction

async function batches(rows, fn) {
  for (let i = 0; i < rows.length; i += BATCH) await fn(rows.slice(i, i + BATCH), i);
}

// Manager / Procurement: add or update products from an Excel (.xlsx) or .csv
// file. Step 1 reads the file in the browser and has the server check every row
// (dry run, batch by batch). Step 2 imports batch by batch with a progress bar;
// if it stops, Resume continues from the first batch that was not saved.
// For very large catalogues the Cloud Shell script scripts/40-bulk-import.mjs
// does the same from a CSV.
export default function ImportProducts({ token, onClose, onImported, read = readSheetFile }) {
  const [file, setFile] = useState('');
  const [rows, setRows] = useState(null);
  const [problems, setProblems] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { label, done, total }
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [next, setNext] = useState(0); // first row index not yet imported

  async function choose(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f.name);
    setPreview(null);
    setDone(null);
    setNext(0);
    setError('');
    setBusy(true);
    try {
      const parsed = rowsToProducts(await read(f));
      setRows(parsed.rows);
      setProblems(parsed.problems);
      if (parsed.rows.length === 0) setError('The file has no product rows.');
      else setPreview(await check(parsed.rows));
    } catch (err) {
      setError(`Could not read ${f.name}: ${err.message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function check(list) {
    const total = { created: 0, updated: 0, unchanged: 0, errors: [], rows: [] };
    await batches(list, async (part, i) => {
      setProgress({ label: 'Checking', done: i, total: list.length });
      let r;
      try {
        r = await api('/api/products/import', { method: 'POST', token, body: { rows: part, dryRun: true, startRow: i + 2 } });
      } catch (err) {
        if (err.status === 400 && err.body?.errors)
          r = err.body; // per-row problems: show them in the table
        else throw err;
      }
      total.created += r.created;
      total.updated += r.updated;
      total.unchanged += r.unchanged;
      total.errors.push(...r.errors);
      if (total.rows.length < 200) total.rows.push(...r.rows.slice(0, 200 - total.rows.length));
    });
    return total;
  }

  async function confirm() {
    setBusy(true);
    setError('');
    const totals = { created: done?.created ?? 0, updated: done?.updated ?? 0 }; // a resume adds to the earlier batches
    try {
      const rest = rows.slice(next);
      await batches(rest, async (part, i) => {
        setProgress({ label: 'Importing', done: next + i, total: rows.length });
        const out = await api('/api/products/import', { method: 'POST', token, body: { rows: part, startRow: next + i + 2 } });
        totals.created += out.created;
        totals.updated += out.updated;
        setNext(next + i + part.length);
      });
      setDone({ ...totals, finished: true });
      onImported?.(totals);
    } catch (err) {
      setDone({ ...totals, finished: false });
      setError(`${err.message} - the batches before this point are saved. Press Resume to continue.`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const errors = preview?.errors || [];
  const count = preview ? preview.created + preview.updated : 0;
  const finished = done?.finished;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="card dialog wide">
        <h2 id="import-title">Import products from Excel</h2>
        <p className="muted">
          One row per product with the headings <b>SKU, Barcode, Name, Category, Sub-category, Price, Tax %, Stock, Expiry date, Refundable, Active</b>.
          Existing SKUs are updated (only the columns in the file); new SKUs are added. Every row is checked before anything is saved; large files are imported
          in batches of {BATCH}.{' '}
          <button type="button" className="link" onClick={() => downloadProducts([], 'eurc-products-template.xlsx')}>
            Download the template
          </button>
        </p>
        <label>
          Excel or CSV file
          <input type="file" accept=".xlsx,.csv" onChange={choose} aria-label="Excel or CSV file" disabled={busy} />
        </label>
        {busy && !progress && <p className="muted">Reading {file}…</p>}
        {progress && (
          <div role="status" aria-label="Progress">
            <p className="muted">
              {progress.label} {file}: {progress.done.toLocaleString('en-CA')} / {progress.total.toLocaleString('en-CA')} rows
            </p>
            <div className="progress">
              <span style={{ width: `${Math.round((100 * progress.done) / progress.total)}%` }} />
            </div>
          </div>
        )}
        {problems.length > 0 && (
          <ul className="notice">
            {problems.slice(0, 50).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 50 && <li>…and {problems.length - 50} more</li>}
          </ul>
        )}
        {preview && !finished && (
          <>
            <p data-testid="import-summary">
              <b>{preview.created.toLocaleString('en-CA')}</b> new · <b>{preview.updated.toLocaleString('en-CA')}</b> updated ·{' '}
              <b>{preview.unchanged.toLocaleString('en-CA')}</b> unchanged
              {errors.length > 0 && (
                <>
                  {' '}
                  · <b className="bad">{errors.length} to fix</b>
                </>
              )}
            </p>
            <div className="scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>SKU</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.slice(0, 200).map((e) => (
                    <tr key={`e${e.row}`} className="bad">
                      <td>{e.row}</td>
                      <td>{e.sku}</td>
                      <td>{e.error}</td>
                    </tr>
                  ))}
                  {preview.rows.map((r) => (
                    <tr key={`r${r.row}`}>
                      <td>{r.row}</td>
                      <td>{r.sku}</td>
                      <td>{r.action === 'create' ? `new: ${r.name}` : r.action === 'update' ? `update ${r.changed.join(', ')}` : 'no change'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > preview.rows.length + errors.length && <p className="hint">Showing the first rows of {rows.length.toLocaleString('en-CA')}.</p>}
          </>
        )}
        {finished && (
          <p className="ok" role="status">
            Imported: {done.created.toLocaleString('en-CA')} new, {done.updated.toLocaleString('en-CA')} updated.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button className="primary" disabled={!preview || errors.length > 0 || busy || count === 0} onClick={confirm}>
              {done ? 'Resume import' : `Import ${count.toLocaleString('en-CA')} products`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
