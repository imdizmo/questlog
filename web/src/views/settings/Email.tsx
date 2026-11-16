import { useEffect, useId, useState } from 'react';
import { api, dispatch } from '../../api';

export type NotificationPref = 'off' | 'daily' | 'instant';
export interface OutboxRow {
  id: number; toAddr: string; subject: string; kind: string; status: 'pending' | 'sent' | 'failed' | 'log';
  createdAt: number; sentAt: number | null; attempts: number; lastError: string | null;
  /** Log mode only, sign-up confirmations: the link, to pass on by hand. */
  link?: string;
}
export interface EmailStatus {
  transport: 'log' | 'smtp';
  smtp: { host: string; port: number; from: string; starttls: boolean; auth: boolean } | null;
  publicUrl: string;
  counts: { pending: number; sent: number; failed: number; log: number };
  outbox: OutboxRow[];
}

const STATUS_LABEL: Record<OutboxRow['status'], string> = { pending: 'Waiting', sent: 'Sent', failed: 'Failed', log: 'Not sent (log mode)' };
const KIND_LABEL: Record<string, string> = {
  notifications: 'Notifications', reportDone: 'Report done', invite: 'Invite',
  openDeckUpdates: 'Public list update', openDeckDigest: 'Upvote digest', openDeckConfirm: 'Sign-up confirmation', openDeckNotice: 'Sign-up notice',
};

/** Workspace settings > Email (admins): how mail leaves the server, and the newest 200 emails of the outbox. */
export function EmailAdmin() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [error, setError] = useState(false);
  const load = () => { setError(false); api.emailStatus().then(setStatus, () => setError(true)); };
  useEffect(load, []);
  if (error) return <p role="alert">Couldn't load the email status. <button type="button" className="btn btn-ghost" onClick={load}>Try again</button></p>;
  if (!status) return <p className="muted">Loading…</p>;
  return <EmailAdminView status={status} onRefresh={load} />;
}

export function EmailAdminView({ status, onRefresh }: { status: EmailStatus; onRefresh?: () => void }) {
  const { smtp, counts } = status;
  return (
    <div className="settings-stack">
      <section className="settings-group" aria-labelledby="email-transport">
        <h3 className="sub" id="email-transport">Sending</h3>
        {status.transport === 'log' || !smtp ? (
          <p>
            <strong>Log mode.</strong> Emails are collected below but never leave this server. To send them, start the server with
            {' '}<code>EMAIL_TRANSPORT=smtp</code> and your mail server's <code>SMTP_*</code> settings (see the README).
          </p>
        ) : (
          <dl className="facts">
            <dt>Mail server</dt><dd>{smtp.host}:{smtp.port}{smtp.starttls ? ', encrypted with STARTTLS' : ', not encrypted'}</dd>
            <dt>Sender</dt><dd>{smtp.from}</dd>
            <dt>Sign-in</dt><dd>{smtp.auth ? 'With a user name and password' : 'None'}</dd>
          </dl>
        )}
        <p className="hint">Links in emails point to <code>{status.publicUrl}</code> (set it with <code>JT_PUBLIC_URL</code>).</p>
      </section>

      <section className="settings-group" aria-labelledby="email-outbox">
        <h3 className="sub" id="email-outbox">Outbox</h3>
        <p className="hint">
          {counts.pending} waiting, {counts.sent} sent, {counts.failed} failed{counts.log ? `, ${counts.log} kept in log mode` : ''}.
          Up to 20 emails go out each minute; a failed one is tried again up to five times.
        </p>
        {onRefresh && <div className="row"><button type="button" className="btn" onClick={onRefresh}>Refresh</button></div>}
        {status.outbox.length === 0 ? <p className="muted">No emails yet.</p> : (
          <div className="table-wrap">
            <table className="table" aria-label="Outbox">
              <thead><tr><th scope="col">Created</th><th scope="col">To</th><th scope="col">Subject</th><th scope="col">Kind</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {status.outbox.map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.createdAt).toLocaleString()}</td>
                    <td>{o.toAddr}</td>
                    <th scope="row">{o.subject}</th>
                    <td>{KIND_LABEL[o.kind] ?? o.kind}</td>
                    <td title={o.lastError ?? undefined}>
                      {STATUS_LABEL[o.status]}
                      {o.status === 'pending' && o.attempts > 0 && ` (tried ${o.attempts}×)`}
                      {o.status === 'failed' && o.lastError && <span className="muted"> {o.lastError}</span>}
                      {o.link && <> <a href={o.link} className="outbox-link" title="Nothing is sent in log mode: give this link to the person if you trust the request">Confirmation link</a></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const PREFS: [NotificationPref, string, string][] = [
  ['daily', 'Daily round-up', 'One email at 8:00 in your timezone with the conversations that have news for you.'],
  ['instant', 'Right away', 'An email within a few minutes when a conversation you follow has news (at most one every five minutes).'],
  ['off', 'No emails', 'Keep up through Messages only.'],
];

/** My notification emails (account menu > Email notifications). Saved as soon as a choice is picked. */
export function EmailPrefs() {
  const [pref, setPref] = useState<NotificationPref | null>(null);
  const [busy, setBusy] = useState(false);
  const name = useId();
  useEffect(() => {
    let live = true;
    api.emailPrefs().then((r) => { if (live) setPref(r.notifications); }, () => { if (live) setPref('daily'); });
    return () => { live = false; };
  }, []);
  const pick = async (p: NotificationPref) => {
    const before = pref;
    setPref(p);
    setBusy(true);
    try { await dispatch('emailPrefs', 'update', { notifications: p }); } catch { setPref(before); } finally { setBusy(false); }
  };
  if (!pref) return <p className="muted">Loading…</p>;
  return (
    <fieldset className="choice-list" disabled={busy}>
      <legend>Emails about conversations you follow</legend>
      {PREFS.map(([p, title, blurb]) => (
        <label key={p} className={pref === p ? 'choice selected' : 'choice'}>
          <input type="radio" name={name} checked={pref === p} onChange={() => void pick(p)} />
          <span className="choice-title">{title}</span>
          <span className="choice-blurb">{blurb}</span>
        </label>
      ))}
    </fieldset>
  );
}
