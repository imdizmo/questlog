import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, messageFor } from '../api';
import { navigate } from '../router';
import { AuthCard, Field } from '../components/AuthCard';

const ROLE_TEXT: Record<string, string> = { admin: 'an admin', member: 'a member', observer: 'an observer' };

/** Accept an invite link: create an account and join the workspace. */
export function Join({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ role: string } | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.invite(token).then((r) => { if (live) setInvite(r); })
      .catch((err) => { if (live) setDead(messageFor(err instanceof ApiError ? err.code : 'network')); });
    return () => { live = false; };
  }, [token]);

  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite(token, f);
      onDone();
      navigate('/decks', { replace: true });
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : 'network'));
    } finally {
      setBusy(false);
    }
  };

  if (dead) {
    return (
      <AuthCard title="Can't use this invite" error={dead}>
        <p className="auth-lead">Ask whoever sent it for a new link, or <a href="/login">log in</a> if you already have an account.</p>
      </AuthCard>
    );
  }
  if (!invite) return <AuthCard title="Checking your invite…"><p className="auth-lead">One moment.</p></AuthCard>;

  return (
    <AuthCard title="Join the workspace" lead={`You're invited as ${ROLE_TEXT[invite.role] ?? invite.role}. Create your account to continue.`} error={error}>
      <form onSubmit={submit} className="stack">
        <Field label="Your name" required autoFocus autoComplete="name" {...bind('name')} />
        <Field label="Email" type="email" required autoComplete="email" {...bind('email')} />
        <Field label="Password" type="password" required minLength={8} autoComplete="new-password" {...bind('password')} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Join</button>
      </form>
    </AuthCard>
  );
}
