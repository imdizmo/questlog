import { useMemo, useState } from 'react';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { showToast } from '../../toast';
import { CopyField } from './CopyField';
import { DeckOptions } from './UserReports';
import { SecretField, secretChange, useIntegrations } from './Discord';

export interface SlackSettings {
  teamId: string | null;
  addCardDeckId: string | null;
  projectIds: string[];
  webhookSet: boolean;
  signingSecretSet: boolean;
  botTokenSet: boolean;
}

/** Workspace settings > Slack (admins): project news in a channel, and /addcard. */
export function SlackIntegration() {
  const { data, failed, load } = useIntegrations();
  if (failed) return <p role="alert" className="field-error">Couldn't load the Slack settings.</p>;
  if (!data) return <p className="hint">Loading…</p>;
  return <SlackForm key={JSON.stringify(data.slack)} s={data.slack} onSaved={load} />;
}

function SlackForm({ s, onSaved }: { s: SlackSettings; onSaved: () => void }) {
  const projects = useStore((st) => st.projects);
  const projectList = useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq), [projects]);
  const [webhook, setWebhook] = useState('');
  const [webhookCleared, setWebhookCleared] = useState(false);
  const [signing, setSigning] = useState('');
  const [signingCleared, setSigningCleared] = useState(false);
  const [bot, setBot] = useState('');
  const [botCleared, setBotCleared] = useState(false);
  const [deckId, setDeckId] = useState(s.addCardDeckId ?? '');
  const [teamId, setTeamId] = useState(s.teamId ?? '');
  const [projectIds, setProjectIds] = useState(new Set(s.projectIds));
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await dispatch('integrations', 'updateSlack', {
        webhookUrl: secretChange(webhook, webhookCleared),
        signingSecret: secretChange(signing, signingCleared),
        botToken: secretChange(bot, botCleared),
        teamId: teamId.trim() || null,
        addCardDeckId: deckId || null,
        projectIds: [...projectIds],
      });
      showToast('Slack settings saved', 'info', 2000);
      onSaved();
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string, on: boolean) => setProjectIds((cur) => {
    const next = new Set(cur);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  return (
    <form className="settings-stack" onSubmit={save} aria-label="Slack settings">
      <section className="settings-group" aria-labelledby="sl-news">
        <h3 className="sub" id="sl-news">Project news</h3>
        <p className="hint">New tasks, finished tasks, comments and new milestones of the projects you tick are posted to a channel through an incoming webhook.</p>
        <SecretField label="Incoming webhook URL" set={s.webhookSet} value={webhook} onChange={setWebhook} cleared={webhookCleared}
          onClear={() => setWebhookCleared(true)} placeholder="https://hooks.slack.com/services/…" />
        <fieldset className="field-set">
          <legend>Projects</legend>
          {projectList.length === 0 && <p className="hint">No projects yet.</p>}
          {projectList.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={projectIds.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /> {p.name}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="settings-group" aria-labelledby="sl-cmd">
        <h3 className="sub" id="sl-cmd">/addcard</h3>
        <p className="hint">
          Anyone in your Slack whose email address belongs to a member here can type <code>/addcard</code> and some text: the task is made in
          the list below, as them, and lands in their bookmarks. Create a slash command in your Slack app with this request URL:
        </p>
        <CopyField label="Request URL" value={`${location.origin}/integrations/slack/commands`} />
        <SecretField label="Signing secret" set={s.signingSecretSet} value={signing} onChange={setSigning} cleared={signingCleared}
          onClear={() => setSigningCleared(true)} hint="From your Slack app's Basic Information page. Stored encrypted." />
        <SecretField label="Bot token" set={s.botTokenSet} value={bot} onChange={setBot} cleared={botCleared} onClear={() => setBotCleared(true)}
          placeholder="xoxb-…" hint="Needs the users:read.email scope; only used to look up who typed the command. Stored encrypted." />
        <label className="field"><span>Slack workspace id</span>
          <input spellCheck={false} placeholder="T0123ABCD" value={teamId} onChange={(e) => setTeamId(e.target.value)} />
          <small className="hint">Starts with T. /addcard is accepted from this Slack workspace only, from full members whose email Slack has confirmed.</small></label>
        <label className="field"><span>Create tasks in</span>
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">Nowhere yet (/addcard is off)</option>
            <DeckOptions />
          </select></label>
      </section>

      <div><button type="submit" className="btn btn-primary" disabled={busy}>Save</button></div>
    </form>
  );
}
