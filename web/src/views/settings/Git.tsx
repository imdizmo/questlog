import { useEffect, useMemo, useState } from 'react';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { showToast } from '../../toast';
import { completeStep } from '../../onboarding';
import { CopyField } from './CopyField';
import { useIntegrations } from './Discord';

export type GitKind = 'github' | 'gitlab' | 'bitbucket';
export interface GitHook {
  id: string; kind: GitKind; projectId: string | null; creatorId: string; createdAt: number; lastDeliveryAt: number | null;
  /** Without the secret (a BitBucket URL ends in "/…"). */
  url: string;
}

const HOST_NAME: Record<GitKind, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'BitBucket' };
const HOW: Record<GitKind, string> = {
  github: 'In the repository open Settings › Webhooks › Add webhook. Paste the payload URL and the secret, choose the content type application/json and let it send just the push event. Gitea and other GitHub-compatible hosts work the same way.',
  gitlab: 'In the project open Settings › Webhooks. Paste the URL and the secret token and tick Push events. This works for self-hosted GitLab as well.',
  bitbucket: 'In the repository open Repository settings › Webhooks › Add webhook. Paste the URL (it already contains the secret) and trigger it on Repository push.',
};

/** Workspace settings > GitHub / GitLab / BitBucket (admins): webhook URLs that turn commit messages into card history. */
export function GitIntegration({ kind }: { kind: GitKind }) {
  const { data, failed, load } = useIntegrations();
  const projects = useStore((s) => s.projects);
  const users = useStore((s) => s.users);
  const projectList = useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq), [projects]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  // The secret exists only in the answer to "create": kept here until the tab is left.
  const [fresh, setFresh] = useState<{ id: string; url: string; secret?: string } | null>(null);
  useEffect(() => { completeStep('applySCMIntegration'); }, []);

  const name = HOST_NAME[kind];
  if (failed) return <p role="alert" className="field-error">Couldn't load the {name} settings.</p>;
  if (!data) return <p className="hint">Loading…</p>;
  const hooks = data.gitHooks.filter((h) => h.kind === kind);

  const create = async () => {
    setBusy(true);
    try {
      setFresh(await dispatch<{ id: string; url: string; secret?: string }>('integrations', 'createGitHook', { kind, projectId: projectId || null }));
      load();
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await dispatch('integrations', 'deleteGitHook', { id });
      if (fresh?.id === id) setFresh(null);
      showToast('Webhook removed', 'info', 2000);
      load();
    } catch { /* toast shown by dispatch */ }
  };

  return (
    <div className="settings-stack" aria-label={`${name} settings`}>
      <section className="settings-group" aria-labelledby={`git-${kind}-how`}>
        <h3 className="sub" id={`git-${kind}-how`}>Commit references</h3>
        <p className="hint">
          Write a task's code with a dollar sign in a commit message, like <code>$11a</code>, and the task's history shows the commit with a link.
          <code> closes $11a</code> marks the task done and <code>review $11a</code> sends it for review, both as the person who created the webhook,
          so only what they are allowed to do happens. Codes inside links are ignored.
        </p>
        <p className="hint">{HOW[kind]}</p>
        <p className="hint">{name} calls this server, so it must be reachable from where {name} runs (a LAN address is fine for a self-hosted host).</p>
      </section>

      <section className="settings-group" aria-labelledby={`git-${kind}-new`}>
        <h3 className="sub" id={`git-${kind}-new`}>New webhook</h3>
        <label className="field"><span>Only tasks of</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Every project</option>
            {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <div><button type="button" className="btn btn-primary" disabled={busy} onClick={create}>Generate webhook URL</button></div>
        {fresh && (
          <div role="status" className="settings-group">
            <p className="hint">Copy these now: {fresh.secret ? 'the secret' : 'the secret in the URL'} is not shown again.</p>
            <CopyField label={fresh.secret ? 'Payload URL' : 'Webhook URL'} value={fresh.url} />
            {fresh.secret && <CopyField label="Secret" value={fresh.secret} />}
          </div>
        )}
      </section>

      <section className="settings-group" aria-labelledby={`git-${kind}-list`}>
        <h3 className="sub" id={`git-${kind}-list`}>Webhooks</h3>
        {hooks.length === 0 && <p className="hint">None yet.</p>}
        <ul className="plain-list">
          {hooks.map((h) => (
            <li key={h.id} className="field-row">
              <span>
                <code>{h.url}</code><br />
                <small className="muted">
                  Made by {users.get(h.creatorId)?.name ?? 'someone'} on {new Date(h.createdAt).toLocaleDateString()}
                  {h.projectId ? ` · only ${projects.get(h.projectId)?.name ?? 'one project'}` : ''}
                  {' · '}{h.lastDeliveryAt ? `last delivery ${new Date(h.lastDeliveryAt).toLocaleString()}` : 'no delivery yet'}
                </small>
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => remove(h.id)}>Delete</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
