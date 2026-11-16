import { useState, type FormEvent } from 'react';
import { api, ApiError, messageFor } from '../api';
import { navigate, useLocation } from '../router';
import { AuthCard, Field } from '../components/AuthCard';

/** Only same-site paths are allowed as a return target. */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/decks');

export function Login({ onDone }: { onDone: () => void }) {
  const { query } = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ email, password });
      onDone();
      navigate(safeNext(query.get('next')), { replace: true });
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : 'network'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Log in" error={error}>
      <form onSubmit={submit} className="stack">
        <Field label="Email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Log in</button>
      </form>
    </AuthCard>
  );
}
