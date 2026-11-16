import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, dispatch } from '../../api';
import { useStore } from '../../store';
import { showToast } from '../../toast';
import { CopyField } from './CopyField';
import { DeckOptions } from './UserReports';
import type { SlackSettings } from './Slack';
import type { GitHook } from './Git';

type CommandName = 'bug' | 'card';
export interface DiscordSettings {
  applicationId: string | null;
  publicKey: string | null;
  guildId: string | null;
  botTokenSet: boolean;
  commands: { channelId: string; name: CommandName; deckId: string }[];
  projectNotifications: { projectId: string; webhookSet: boolean }[];
  karmaRoleThresholds: { roleId: string; upvotes: number }[];
  karmaActive: boolean;
}
export interface IntegrationSettings { discord: DiscordSettings; slack: SlackSettings; gitHooks: GitHook[] }

/** Loads the integration settings for one of the two tabs. */
export function useIntegrations() {
  const [data, setData] = useState<IntegrationSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api.integrations().then((d) => { setData(d); setFailed(false); }, () => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);
  return { data, failed, load };
}

/** A secret field: never shows the stored value, only whether one is set. Empty input = keep; "Remove" = clear. */
export function SecretField({ label, set, value, onChange, cleared, onClear, hint, placeholder }: {
  label: string; set: boolean; value: string; onChange: (v: string) => void; cleared: boolean; onClear: () => void; hint?: string; placeholder?: string;
}) {
  const id = useId();
  const state = cleared ? 'Will be removed when you save' : set ? 'Set' : 'Not set';
  return (
    <div className="field-row">
      <label className="field">
        <span>{label} <small className="muted">({state})</small></span>
        <input type="password" autoComplete="off" spellCheck={false} value={value} aria-describedby={hint ? `${id}-h` : undefined}
          placeholder={set && !cleared ? 'Saved; type to replace it' : placeholder} onChange={(e) => onChange(e.target.value)} />
        {hint && <small className="hint" id={`${id}-h`}>{hint}</small>}
      </label>
      {set && !cleared && <button type="button" className="btn btn-ghost" onClick={onClear}>Remove</button>}
    </div>
  );
}

/** A secret edit: a new value, null to remove, undefined to keep. */
export const secretChange = (value: string, cleared: boolean): string | null | undefined => (value.trim() ? value.trim() : cleared ? null : undefined);

/** Workspace settings > Discord (admins): slash commands that make cards, and news per project in a channel. */
export function DiscordIntegration() {
  const { data, failed, load } = useIntegrations();
  if (failed) return <p role="alert" className="field-error">Couldn't load the Discord settings.</p>;
  if (!data) return <p className="hint">Loading…</p>;
  return <DiscordForm key={JSON.stringify(data.discord)} s={data.discord} onSaved={load} />;
}

interface NotifyRow { projectId: string; webhook: string; set: boolean; cleared: boolean }

function DiscordForm({ s, onSaved }: { s: DiscordSettings; onSaved: () => void }) {
  const projects = useStore((st) => st.projects);
  const projectList = useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq), [projects]);
  const [applicationId, setApplicationId] = useState(s.applicationId ?? '');
  const [publicKey, setPublicKey] = useState(s.publicKey ?? '');
  const [guildId, setGuildId] = useState(s.guildId ?? '');
  const [botToken, setBotToken] = useState('');
  const [botCleared, setBotCleared] = useState(false);
  const [commands, setCommands] = useState(s.commands);
  const [notify, setNotify] = useState<NotifyRow[]>(s.projectNotifications.map((p) => ({ projectId: p.projectId, webhook: '', set: p.webhookSet, cleared: false })));
  const [karma, setKarma] = useState(s.karmaRoleThresholds.map((k) => ({ roleId: k.roleId, upvotes: String(k.upvotes) })));
  const [busy, setBusy] = useState(false);
  const endpoint = `${location.origin}/integrations/discord/interactions`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await dispatch('integrations', 'updateDiscord', {
        applicationId: applicationId.trim() || null,
        publicKey: publicKey.trim() || null,
        guildId: guildId.trim() || null,
        botToken: secretChange(botToken, botCleared),
        commands: commands.filter((c) => c.channelId.trim() && c.deckId).map((c) => ({ ...c, channelId: c.channelId.trim() })),
        projectNotifications: notify.filter((n) => n.projectId && !(n.cleared && !n.webhook.trim())).map((n) => ({ projectId: n.projectId, webhookUrl: secretChange(n.webhook, false) })),
        karmaRoleThresholds: karma.filter((k) => k.roleId.trim() && Number(k.upvotes) > 0).map((k) => ({ roleId: k.roleId.trim(), upvotes: Math.floor(Number(k.upvotes)) })),
      });
      showToast('Discord settings saved', 'info', 2000);
      onSaved();
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  const register = async () => {
    setBusy(true);
    try {
      await dispatch('integrations', 'registerDiscordCommands', {});
      showToast('/bug and /card are registered with Discord', 'info', 3000);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-stack" onSubmit={save} aria-label="Discord settings">
      <section className="settings-group" aria-labelledby="dc-app">
        <h3 className="sub" id="dc-app">Your Discord application</h3>
        <p className="hint">
          Create an application in Discord's developer portal, add its bot to your server, and paste its details here.
          Then set the application's interactions endpoint to the address below.
        </p>
        <CopyField label="Interactions endpoint URL" value={endpoint} />
        <label className="field"><span>Application id</span>
          <input inputMode="numeric" value={applicationId} onChange={(e) => setApplicationId(e.target.value)} /></label>
        <label className="field"><span>Public key</span>
          <input spellCheck={false} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} /></label>
        <label className="field"><span>Server (guild) id</span>
          <input inputMode="numeric" value={guildId} onChange={(e) => setGuildId(e.target.value)} />
          <small className="hint">Commands from other servers are turned away.</small></label>
        <SecretField label="Bot token" set={s.botTokenSet} value={botToken} onChange={setBotToken} cleared={botCleared} onClear={() => setBotCleared(true)}
          hint="Only used when you register the commands. Stored encrypted." />
      </section>

      <section className="settings-group" aria-labelledby="dc-cmd">
        <h3 className="sub" id="dc-cmd">Slash commands</h3>
        <p className="hint"><code>/bug</code> and <code>/card</code> make a task in the list you pick for that channel.</p>
        {commands.map((c, i) => (
          <fieldset key={i} className="field-row" aria-label={`Command ${i + 1}`}>
            <label className="field"><span>Channel id</span>
              <input inputMode="numeric" value={c.channelId} onChange={(e) => setCommands(commands.map((x, j) => (j === i ? { ...x, channelId: e.target.value } : x)))} /></label>
            <label className="field"><span>Command</span>
              <select value={c.name} onChange={(e) => setCommands(commands.map((x, j) => (j === i ? { ...x, name: e.target.value as CommandName } : x)))}>
                <option value="bug">/bug</option><option value="card">/card</option>
              </select></label>
            <label className="field"><span>List</span>
              <select value={c.deckId} onChange={(e) => setCommands(commands.map((x, j) => (j === i ? { ...x, deckId: e.target.value } : x)))}>
                <option value="" disabled>Choose a list</option>
                <DeckOptions />
              </select></label>
            <button type="button" className="btn btn-ghost" onClick={() => setCommands(commands.filter((_, j) => j !== i))}>Remove</button>
          </fieldset>
        ))}
        <div className="row">
          <button type="button" className="btn" onClick={() => setCommands([...commands, { channelId: '', name: 'bug', deckId: '' }])}>Add a channel</button>
          <button type="button" className="btn" disabled={busy || !s.applicationId || !s.botTokenSet} onClick={() => void register()}>Register commands with Discord</button>
        </div>
        {(!s.applicationId || !s.botTokenSet) && <p className="hint">Save an application id and a bot token to register the commands.</p>}
      </section>

      <section className="settings-group" aria-labelledby="dc-news">
        <h3 className="sub" id="dc-news">Project news</h3>
        <p className="hint">New tasks, finished tasks, comments and new milestones of a project are posted to a channel webhook (Channel settings, Integrations, Webhooks).</p>
        {notify.map((n, i) => (
          <fieldset key={i} className="field-row" aria-label={`Project news ${i + 1}`}>
            <label className="field"><span>Project</span>
              <select value={n.projectId} onChange={(e) => setNotify(notify.map((x, j) => (j === i ? { ...x, projectId: e.target.value, set: false } : x)))}>
                <option value="" disabled>Choose a project</option>
                {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <SecretField label="Webhook URL" set={n.set} value={n.webhook} placeholder="https://discord.com/api/webhooks/…"
              onChange={(v) => setNotify(notify.map((x, j) => (j === i ? { ...x, webhook: v } : x)))}
              cleared={n.cleared} onClear={() => setNotify(notify.map((x, j) => (j === i ? { ...x, cleared: true } : x)))} />
          </fieldset>
        ))}
        <div className="row"><button type="button" className="btn" onClick={() => setNotify([...notify, { projectId: '', webhook: '', set: false, cleared: false }])}>Add a project</button></div>
      </section>

      <section className="settings-group" aria-labelledby="dc-karma">
        <h3 className="sub" id="dc-karma">Karma roles <small className="muted">(inactive)</small></h3>
        <p className="hint">
          Roles for members whose messages collect upvotes. These are saved, but nothing hands out roles yet: that needs a bot that stays
          connected to Discord, which this server doesn't run.
        </p>
        {karma.map((k, i) => (
          <fieldset key={i} className="field-row" aria-label={`Karma role ${i + 1}`}>
            <label className="field"><span>Role id</span>
              <input inputMode="numeric" value={k.roleId} onChange={(e) => setKarma(karma.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))} /></label>
            <label className="field"><span>Upvotes</span>
              <input inputMode="numeric" value={k.upvotes} onChange={(e) => setKarma(karma.map((x, j) => (j === i ? { ...x, upvotes: e.target.value } : x)))} /></label>
            <button type="button" className="btn btn-ghost" onClick={() => setKarma(karma.filter((_, j) => j !== i))}>Remove</button>
          </fieldset>
        ))}
        <div className="row"><button type="button" className="btn" disabled={karma.length >= 20} onClick={() => setKarma([...karma, { roleId: '', upvotes: '10' }])}>Add a role</button></div>
      </section>

      <div><button type="submit" className="btn btn-primary" disabled={busy}>Save</button></div>
    </form>
  );
}
