import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type AccountSettings as Settings } from '../../../shared/types';
import { dispatch } from '../api';
import { useStore } from '../store';
import { showToast } from '../toast';
import { Dialog } from '../components/Dialog';
import { ApiTokens } from './settings/ApiTokens';
import { McpSettings } from './settings/Mcp';
import { CsvImport } from './settings/CsvImport';
import { UserReports } from './settings/UserReports';
import { HacknPlanImport, TrelloImport } from './settings/Importers';
import { CloneProjects } from './settings/Clone';
import { BillingSettings } from './settings/Billing';
import { DangerZone } from './settings/DangerZone';
import { EmailAdmin } from './settings/Email';
import { DiscordIntegration } from './settings/Discord';
import { SlackIntegration } from './settings/Slack';
import { GitIntegration } from './settings/Git';
import { SteamIntegration } from './settings/Steam';
import { featureAllowed, type PlanFeature } from '../../../shared/plans';

type Tab = 'general' | 'features' | 'billing' | 'email' | 'apiTokens' | 'mcp' | 'discord' | 'slackIntegration' | 'githubIntegration' | 'gitlabIntegration' | 'bitbucketIntegration' | 'steamIntegration' | 'csvImporter' | 'trelloImporter' | 'hacknplanImporter' | 'clone' | 'userReportApi' | 'unity' | 'dangerZone';
const TABS: [Tab, string][] = [
  ['general', 'General'], ['features', 'Features'], ['billing', 'Billing'], ['email', 'Email'], ['apiTokens', 'API tokens'], ['mcp', 'MCP'], ['discord', 'Discord'], ['slackIntegration', 'Slack'], ['githubIntegration', 'GitHub'], ['gitlabIntegration', 'GitLab'], ['bitbucketIntegration', 'BitBucket'], ['steamIntegration', 'Steam'], ['csvImporter', 'CSV import'],
  ['trelloImporter', 'Trello import'], ['hacknplanImporter', 'HacknPlan import'], ['clone', 'Clone projects'],
  ['userReportApi', 'User reports via API'], ['unity', 'User reports (Unity)'], ['dangerZone', 'Danger Zone'],
];
/** Tabs with their own live controls: no shared form and no Save button. */
const LIVE_TABS = new Set<Tab>(['billing', 'email', 'apiTokens', 'mcp', 'discord', 'slackIntegration', 'githubIntegration', 'gitlabIntegration', 'bitbucketIntegration', 'steamIntegration', 'csvImporter', 'trelloImporter', 'hacknplanImporter', 'clone', 'userReportApi', 'unity', 'dangerZone']);
/** Number fields are edited as text so a half-typed value is never coerced behind the person's back. */
type NumKey = 'staleHours' | 'autoArchiveHours' | 'fallbackEffort' | 'maxHandSlots';

const WEEKDAYS = [
  [1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [7, 'Sun', 'Sunday'],
] as const;

/** Flags are stored only in this version; each line is our own description. */
const FEATURES: { key: string; label: string; blurb: string; plan?: PlanFeature; get: (s: Settings) => boolean; set: (on: boolean) => Partial<Settings> }[] = [
  { key: 'milestones', label: 'Milestones', blurb: 'Dated goals that collect the tasks needed to reach them.',
    get: (s) => s.milestonesEnabled, set: (on) => ({ milestonesEnabled: on }) },
  { key: 'effort', label: 'Effort points', blurb: 'A size on each task, added up per list, sprint and milestone. Off: progress counts tasks.',
    get: (s) => s.effortEnabled, set: (on) => ({ effortEnabled: on }) },
  { key: 'sprints', label: 'Sprints', blurb: 'Repeating time boxes to plan the next stretch of work.',
    get: (s) => s.sprintsEnabled, set: (on) => ({ sprintsEnabled: on }) },
  { key: 'journeys', label: 'Task chains', blurb: 'Reusable step lists that turn one task into a set of subtasks.',
    get: (s) => s.workflowMode === 'journeys', set: (on) => ({ workflowMode: on ? 'journeys' : null }) },
  { key: 'vision', label: 'Vision board', blurb: 'A free canvas for ideas, sketches and the tasks they lead to.',
    get: (s) => s.visionBoardEnabled, set: (on) => ({ visionBoardEnabled: on }) },
  { key: 'due', label: 'Due dates', plan: 'dueDates', blurb: 'A deadline on a single task, next to milestones and sprints.',
    get: (s) => s.dueDateEnabled, set: (on) => ({ dueDateEnabled: on }) },
  { key: 'time', label: 'Time tracking', plan: 'timeTracking', blurb: 'A timer that runs while a task is started, plus manual entries.',
    get: (s) => s.timeTrackingMode !== null, set: (on) => ({ timeTrackingMode: on ? 'strict' : null }) },
  { key: 'deps', label: 'Dependencies', plan: 'dependencies', blurb: 'Tasks that wait on other tasks before they can start.',
    get: (s) => s.dependenciesEnabled, set: (on) => ({ dependenciesEnabled: on }) },
];

/** Workspace settings (`?show=accountSettings`, admins only). One Save button sends the whole form. */
export function AccountSettings({ onClose }: { onClose: () => void }) {
  const account = useStore((s) => s.account);
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const initial = { ...DEFAULT_SETTINGS, ...account?.settings };
  const [name, setName] = useState(account?.name ?? '');
  const [f, setF] = useState<Settings>(initial);
  const [nums, setNums] = useState<Record<NumKey, string>>({
    staleHours: String(initial.staleHours),
    autoArchiveHours: String(initial.autoArchiveHours ?? DEFAULT_SETTINGS.autoArchiveHours),
    fallbackEffort: String(initial.fallbackEffort),
    maxHandSlots: String(initial.maxHandSlots),
  });
  // Back from Stripe Checkout or the portal: open on the Billing tab.
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).has('billing') ? 'billing' : 'general'));
  const planOk = (ft: PlanFeature) => featureAllowed(account ?? {}, ft);
  const [busy, setBusy] = useState(false);
  const tabsId = useId();
  const live = LIVE_TABS.has(tab);

  const patch = (p: Partial<Settings>) => setF((x) => ({ ...x, ...p }));
  const num = (k: NumKey) => ({
    type: 'number' as const, inputMode: 'numeric' as const, value: nums[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNums((n) => ({ ...n, [k]: e.target.value })),
  });

  // Decks for the inbox picker, grouped by project.
  const deckGroups = useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq).map((p) => ({
    project: p, decks: [...decks.values()].filter((d) => d.projectId === p.id).sort((a, b) => a.seq - b.seq),
  })).filter((g) => g.decks.length > 0), [projects, decks]);

  const save = async () => {
    const parsed = {} as Record<NumKey, number>;
    const labels: Record<NumKey, string> = {
      staleHours: 'stale time', autoArchiveHours: 'auto-archive time', fallbackEffort: 'fallback effort', maxHandSlots: 'active task slots',
    };
    for (const k of Object.keys(nums) as NumKey[]) {
      const v = Number(nums[k]);
      if (nums[k].trim() === '' || !Number.isFinite(v)) {
        if (k === 'autoArchiveHours' && f.autoArchiveHours === null) continue;
        showToast(`Enter a number for ${labels[k]}.`);
        setTab('general');
        return;
      }
      parsed[k] = v;
    }
    // mcpEnabled is saved by its own switch; sending the form's copy could undo a change made since this form opened.
    const { mcpEnabled: _mcp, ...formSettings } = f;
    const settings = {
      ...formSettings,
      staleHours: parsed.staleHours,
      fallbackEffort: parsed.fallbackEffort,
      maxHandSlots: parsed.maxHandSlots,
      autoArchiveHours: f.autoArchiveHours === null ? null : parsed.autoArchiveHours,
    };
    setBusy(true);
    try {
      await dispatch('accounts', 'update', { ...(name.trim() ? { name: name.trim() } : {}), settings });
      setF((x) => ({ ...x, ...settings }));
      showToast('Settings saved', 'info', 3000);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex(([k]) => k === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
    setTab(next);
    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
  };

  return (
    <Dialog title="Workspace settings" wide scroll onClose={onClose} onSubmit={live ? undefined : save} actions={
      live ? <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button> : (
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Save settings</button>
        </>
      )
    }>
      <div role="tablist" aria-label="Settings areas" className="tabs" onKeyDown={onTabKey}>
        {TABS.map(([t, text]) => (
          <button key={t} id={`${tabsId}-tab-${t}`} type="button" role="tab" className="tab"
            aria-selected={tab === t} aria-controls={`${tabsId}-panel`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>
            {text}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${tab}`} className="settings-panel">
        {tab === 'general' ? (
          <>
            <Group title="Workspace">
              <label className="field">
                <span>Workspace name</span>
                <input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
            </Group>

            <Group title="Task properties">
              <label className="field">
                <span>Effort scale</span>
                <select value={f.effortScale} onChange={(e) => patch({ effortScale: e.target.value })}>
                  <option value="linear">Linear (0 to 10)</option>
                  <option value="fibonacci">Fibonacci (0, 1, 2, 3, 5, 8)</option>
                  <option value="exponential">Doubling (0, 1, 2, 4, 8, 16)</option>
                </select>
                <small className="hint">Any other number can still be typed in on a task.</small>
              </label>
              <fieldset className="field-set">
                <legend>Priority labels</legend>
                <div className="field-row">
                  {(['a', 'b', 'c'] as const).map((k, i) => (
                    <input key={k} aria-label={['Highest', 'Middle', 'Lowest'][i] + ' priority label'} value={f.priorityLabels[k]} maxLength={40}
                      onChange={(e) => patch({ priorityLabels: { ...f.priorityLabels, [k]: e.target.value } })} />
                  ))}
                </div>
              </fieldset>
              <div className="field-row">
                <label className="field">
                  <span>Stale after (hours)</span>
                  <input {...num('staleHours')} />
                  <small className="hint">A started task nobody touches for this long counts as stale.</small>
                </label>
                <label className="field">
                  <span>Fallback effort</span>
                  <input {...num('fallbackEffort')} />
                  <small className="hint">Used for tasks that have no effort set.</small>
                </label>
              </div>
              <fieldset className="field-set">
                <legend>Archive done tasks</legend>
                <div className="inline-options">
                  <label className="radio">
                    <input type="radio" name="autoArchive" checked={f.autoArchiveHours === null} onChange={() => patch({ autoArchiveHours: null })} />
                    Never
                  </label>
                  <label className="radio">
                    <input type="radio" name="autoArchive" checked={f.autoArchiveHours !== null}
                      onChange={() => patch({ autoArchiveHours: Number(nums.autoArchiveHours) || DEFAULT_SETTINGS.autoArchiveHours })} />
                    After
                  </label>
                  <input className="num-inline" aria-label="Hours until done tasks are archived" disabled={f.autoArchiveHours === null} {...num('autoArchiveHours')} />
                  <span className="muted">hours</span>
                </div>
              </fieldset>
            </Group>

            <Group title="Timeline">
              <div className="field-row">
                <label className="field">
                  <span>Scale</span>
                  <select value={f.timelineScale} onChange={(e) => patch({ timelineScale: e.target.value })}>
                    <option value="weeks">Weeks</option>
                    <option value="days">Days</option>
                  </select>
                </label>
                <label className="field">
                  <span>Week starts on</span>
                  <select value={f.weekStart} onChange={(e) => patch({ weekStart: e.target.value })}>
                    <option value="monday">Monday</option>
                    <option value="sunday">Sunday</option>
                    <option value="saturday">Saturday</option>
                  </select>
                </label>
              </div>
              <fieldset className="field-set">
                <legend>Workdays</legend>
                <div className="day-toggles">
                  {WEEKDAYS.map(([n, short, long]) => {
                    const on = f.workdays.includes(n);
                    return (
                      <button key={n} type="button" className={on ? 'day on' : 'day'} aria-pressed={on} aria-label={long}
                        onClick={() => patch({ workdays: on ? f.workdays.filter((d) => d !== n) : [...f.workdays, n].sort() })}>
                        {short}
                      </button>
                    );
                  })}
                </div>
                <small className="hint">Used to count the working days left before a date.</small>
              </fieldset>
            </Group>

            <Group title="Lists">
              <SwitchRow label="Hide done counts on list tiles" checked={f.hideCompletedCounts} onChange={(v) => patch({ hideCompletedCounts: v })} />
              <label className="field">
                <span>Default list for new people</span>
                <select value={f.defaultInboxDeckId ?? ''} onChange={(e) => patch({ defaultInboxDeckId: e.target.value || null })}>
                  <option value="">None</option>
                  {deckGroups.map((g) => (
                    <optgroup key={g.project.id} label={g.project.name}>
                      {g.decks.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                    </optgroup>
                  ))}
                </select>
                <small className="hint">Where new people's quick-added tasks go.</small>
              </label>
            </Group>

            <Group title="Cover images">
              <label className="field">
                <span>Cover image from attachments</span>
                <select value={f.coverFromAttachments} onChange={(e) => patch({ coverFromAttachments: e.target.value })}>
                  <option value="first">First image</option>
                  <option value="latest">Newest image</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <SwitchRow label="Main tasks use their subtasks' covers" checked={f.heroCoverFromSubs} onChange={(v) => patch({ heroCoverFromSubs: v })} />
            </Group>

            <Group title="Tutorial">
              <label className="field">
                <span>Tutorial for team members</span>
                <select value={f.questLevel} onChange={(e) => patch({ questLevel: e.target.value })}>
                  <option value="full">Full</option>
                  <option value="simplified">Simple (only steps that don't change data)</option>
                </select>
              </label>
            </Group>
          </>
        ) : tab === 'billing' ? <BillingSettings />
        : tab === 'email' ? <EmailAdmin />
        : tab === 'apiTokens' ? <ApiTokens />
        : tab === 'mcp' ? <McpSettings />
        : tab === 'discord' ? <DiscordIntegration />
        : tab === 'slackIntegration' ? <SlackIntegration />
        : tab === 'githubIntegration' ? <GitIntegration kind="github" />
        : tab === 'gitlabIntegration' ? <GitIntegration kind="gitlab" />
        : tab === 'bitbucketIntegration' ? <GitIntegration kind="bitbucket" />
        : tab === 'steamIntegration' ? <SteamIntegration />
        : tab === 'csvImporter' ? <CsvImport />
        : tab === 'trelloImporter' ? <TrelloImport />
        : tab === 'hacknplanImporter' ? <HacknPlanImport />
        : tab === 'clone' ? <CloneProjects />
        : tab === 'userReportApi' ? <UserReports key="api" variant="api" />
        : tab === 'unity' ? <UserReports key="unity" variant="unity" />
        : tab === 'dangerZone' ? <DangerZone />
        : (
          <>
            <p className="hint">Switches are saved now; the features themselves arrive in later versions.</p>
            <div className="feature-list">
              {FEATURES.map((ft) => (
                <SwitchRow key={ft.key} label={ft.label} checked={ft.get(f)} onChange={(v) => patch(ft.set(v))}
                  blurb={ft.plan && !planOk(ft.plan) ? `${ft.blurb} Part of the Pro plan: existing values stay visible, new ones need Pro.` : ft.blurb} />
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h3 className="sub" id={id}>{title}</h3>
      {children}
    </section>
  );
}

function SwitchRow({ label, blurb, checked, onChange }: { label: string; blurb?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="setting-row">
      <div>
        <label htmlFor={id} className="setting-label">{label}</label>
        {blurb && <p className="hint" id={`${id}-d`}>{blurb}</p>}
      </div>
      <span className="switch">
        <input id={id} type="checkbox" role="switch" checked={checked} aria-describedby={blurb ? `${id}-d` : undefined}
          onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden className="track" />
      </span>
    </div>
  );
}
