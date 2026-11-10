import React, { useState, useEffect, useCallback } from 'react';

const API = '/api/subscribers';
const FLAGS_API = '/api/flags';

const styles = {
  container: { fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '40px auto', padding: '0 20px' },
  h1: { fontSize: 24, marginBottom: 24 },
  h2: { fontSize: 18, marginBottom: 12 },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 40 },
  th: { textAlign: 'left', borderBottom: '2px solid #ccc', padding: '8px 12px', background: '#f5f5f5' },
  td: { borderBottom: '1px solid #eee', padding: '8px 12px', verticalAlign: 'middle' },
  deleteBtn: { background: '#e53e3e', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' },
  blockBtn: { background: '#dd6b20', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' },
  unblockBtn: { background: '#38a169', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' },
  form: { background: '#f9f9f9', border: '1px solid #ddd', borderRadius: 6, padding: 24, marginBottom: 40 },
  field: { marginBottom: 14 },
  label: { display: 'block', fontWeight: 600, marginBottom: 4, fontSize: 13 },
  input: { width: '100%', padding: '7px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' },
  row: { display: 'flex', gap: 8, marginBottom: 8 },
  addHeaderBtn: { background: '#4a90e2', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 12px', cursor: 'pointer', fontSize: 13 },
  removeHeaderBtn: { background: '#aaa', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 8px', cursor: 'pointer', fontSize: 13 },
  submitBtn: { background: '#38a169', color: '#fff', border: 'none', borderRadius: 4, padding: '9px 20px', cursor: 'pointer', fontSize: 15, marginTop: 8 },
  error: { color: '#e53e3e', marginBottom: 12 },
  empty: { color: '#888', fontStyle: 'italic' },
};

function HeaderEditor({ headers, onChange }) {
  // headers is an array of { key, value } pairs for the form state.
  function updateEntry(index, field, val) {
    const updated = headers.map((h, i) => (i === index ? { ...h, [field]: val } : h));
    onChange(updated);
  }

  return (
    <div>
      {headers.map((h, i) => (
        <div key={i} style={styles.row}>
          <input
            style={{ ...styles.input, flex: 1 }}
            placeholder="Header name"
            value={h.key}
            onChange={(e) => updateEntry(i, 'key', e.target.value)}
          />
          <input
            style={{ ...styles.input, flex: 2 }}
            placeholder="Value"
            value={h.value}
            onChange={(e) => updateEntry(i, 'value', e.target.value)}
          />
          <button
            type="button"
            style={styles.removeHeaderBtn}
            onClick={() => onChange(headers.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        style={styles.addHeaderBtn}
        onClick={() => onChange([...headers, { key: '', value: '' }])}
      >
        + Add header
      </button>
    </div>
  );
}

const EMPTY_FORM = { name: '', topic: '', url: '', headers: [] };

export default function App() {
  const [subscribers, setSubscribers] = useState([]);
  const [flags, setFlags] = useState({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const loadSubscribers = useCallback(async () => {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSubscribers(await res.json());
    } catch (err) {
      setError(`Failed to load subscribers: ${err.message}`);
    }
  }, []);

  const loadFlags = useCallback(async () => {
    try {
      const res = await fetch(FLAGS_API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlags(await res.json());
    } catch (err) {
      setError(`Failed to load flags: ${err.message}`);
    }
  }, []);

  useEffect(() => { loadSubscribers(); loadFlags(); }, [loadSubscribers, loadFlags]);

  async function handleToggleBlock(topic, currentlyBlocked) {
    try {
      const res = await fetch(`${FLAGS_API}/${encodeURIComponent(topic)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_blocked: !currentlyBlocked }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlags((prev) => ({ ...prev, [topic]: !currentlyBlocked }));
    } catch (err) {
      setError(`Toggle failed: ${err.message}`);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this subscriber?')) return;
    try {
      const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSubscribers((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(`Delete failed: ${err.message}`);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!form.name.trim() || !form.topic.trim() || !form.url.trim()) {
      setError('Name, topic, and URL are required.');
      return;
    }

    // Convert the key-value array to an object, skipping blank keys.
    const headers = Object.fromEntries(
      form.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])
    );

    setSubmitting(true);
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, topic: form.topic, url: form.url, headers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const created = await res.json();
      setSubscribers((prev) => [...prev, created]);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(`Create failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.h1}>Webhooks Platform</h1>

      <h2 style={styles.h2}>Subscribers</h2>
      {error && <p style={styles.error}>{error}</p>}
      {subscribers.length === 0 ? (
        <p style={styles.empty}>No subscribers yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Topic</th>
              <th style={styles.th}>URL</th>
              <th style={styles.th}>Headers</th>
              <th style={styles.th}>Delivery</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((s) => {
              const blocked = !!flags[s.topic];
              return (
                <tr key={s.id}>
                  <td style={styles.td}>{s.name}</td>
                  <td style={styles.td}>{s.topic}</td>
                  <td style={styles.td}><code>{s.url}</code></td>
                  <td style={styles.td}>{Object.keys(s.headers || {}).length}</td>
                  <td style={styles.td}>
                    <button
                      style={blocked ? styles.unblockBtn : styles.blockBtn}
                      onClick={() => handleToggleBlock(s.topic, blocked)}
                    >
                      {blocked ? 'Unblock' : 'Block'}
                    </button>
                  </td>
                  <td style={styles.td}>
                    <button style={styles.deleteBtn} onClick={() => handleDelete(s.id)}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form style={styles.form} onSubmit={handleSubmit}>
        <h2 style={{ ...styles.h2, marginTop: 0 }}>Add Subscriber</h2>
        <div style={styles.field}>
          <label style={styles.label}>Name</label>
          <input
            style={styles.input}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="My Service"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Topic</label>
          <input
            style={styles.input}
            value={form.topic}
            onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
            placeholder="orders.created"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>URL</label>
          <input
            style={styles.input}
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            placeholder="https://example.com/webhook"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Custom headers</label>
          <HeaderEditor
            headers={form.headers}
            onChange={(headers) => setForm((f) => ({ ...f, headers }))}
          />
        </div>
        <button style={styles.submitBtn} type="submit" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add Subscriber'}
        </button>
      </form>
    </div>
  );
}
