import { useState, type FormEvent } from 'react';
import { api, ApiError, messageFor } from '../api';
import { navigate } from '../router';
import { AuthCard, Field } from '../components/AuthCard';

/** First run: name the workspace and create the owner account. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ workspaceName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(f);
      onDone();
      navigate('/decks', { replace: true });
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : 'network'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set up your workspace" lead="You'll be its owner. Invite the rest of the team afterwards." error={error}>
      <form onSubmit={submit} className="stack">
        <Field label="Workspace name" required autoFocus placeholder="Studio or team name" {...bind('workspaceName')} />
        <Field label="Your name" required autoComplete="name" {...bind('name')} />
        <Field label="Email" type="email" required autoComplete="email" {...bind('email')} />
        <Field label="Password" type="password" required minLength={8} autoComplete="new-password" {...bind('password')} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Create workspace</button>
      </form>
    </AuthCard>
  );
}
