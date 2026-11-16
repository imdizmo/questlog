import type { ReactNode } from 'react';
import { Mark } from './icons';

/** Centered card used by the setup, login and join screens. */
export function AuthCard({ title, lead, error, children }: { title: string; lead?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <div className="auth-brand"><Mark size={34} /><span><b>Questlog</b></span></div>
        <h1>{title}</h1>
        {lead && <p className="auth-lead">{lead}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {children}
      </div>
    </main>
  );
}

export function Field({ label, ...input }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} />
    </label>
  );
}
