import { useState } from 'react';
import { api } from '../api.js';
import { downloadProducts, readSheetFile, rowsToProducts } from '../lib/excel.js';

// Manager-only: add or update many products from an Excel (.xlsx) or .csv file.
// Step 1 reads the file in the browser and asks the server for a preview
// (dryRun); step 2 imports. The server saves nothing unless every row is valid.
export default function ImportProducts({ token, onClose, onImported, read = readSheetFile }) {
  const [file, setFile] = useState('');
  const [rows, setRows] = useState(null);
  const [problems, setProblems] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  async function choose(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f.name);
    setPreview(null);
    setDone(null);
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
    }
  }

  async function check(list) {
    try {
      return await api('/api/products/import', { method: 'POST', token, body: { rows: list, dryRun: true } });
    } catch (err) {
      if (err.status === 400 && err.body?.errors) return err.body; // per-row problems: show them in the table
      throw err;
    }
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const out = await api('/api/products/import', { method: 'POST', token, body: { rows } });
      setDone(out);
      onImported?.(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const errors = preview?.errors || [];
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="card dialog wide">
        <h2 id="import-title">Import products from Excel</h2>
        <p className="muted">
          One row per product with the headings <b>SKU, Name, Category, Price, Tax %, Stock, Refundable, Active</b>. Existing SKUs are updated (only the
          columns in the file); new SKUs are added. Nothing is saved unless every row is valid.{' '}
          <button type="button" className="link" onClick={() => downloadProducts([], 'eurc-products-template.xlsx')}>
            Download the template
          </button>
        </p>
        <label>
          Excel or CSV file
          <input type="file" accept=".xlsx,.csv" onChange={choose} aria-label="Excel or CSV file" />
        </label>
        {busy && <p className="muted">Checking {file}…</p>}
        {problems.length > 0 && (
          <ul className="notice">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {preview && !done && (
          <>
            <p data-testid="import-summary">
              <b>{preview.created}</b> new · <b>{preview.updated}</b> updated · <b>{preview.unchanged}</b> unchanged
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
                  {errors.map((e) => (
                    <tr key={`e${e.row}`} className="bad">
                      <td>{e.row}</td>
                      <td>{e.sku}</td>
                      <td>{e.error}</td>
                    </tr>
                  ))}
                  {(preview.rows || []).map((r) => (
                    <tr key={`r${r.row}`}>
                      <td>{r.row}</td>
                      <td>{r.sku}</td>
                      <td>{r.action === 'create' ? `new: ${r.name}` : r.action === 'update' ? `update ${r.changed.join(', ')}` : 'no change'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {done && (
          <p className="ok" role="status">
            Imported: {done.created} new, {done.updated} updated.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button className="primary" disabled={!preview || errors.length > 0 || busy || preview.created + preview.updated === 0} onClick={confirm}>
              Import {preview ? preview.created + preview.updated : ''} products
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
