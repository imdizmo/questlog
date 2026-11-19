import { useId, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type AccountSettings as Settings } from '../../../../shared/types';
import { COVER_ARTWORKS } from '../../../../shared/covers';
import { featureAllowed, type PlanFeature } from '../../../../shared/plans';
import { QUESTS, toRoman } from '../../../../shared/quests';
import { useStore } from '../../store';
import { questProgress } from '../../onboarding';
import { setTutorialPaused, useTutorialPaused } from '../../guides';
import { ArtworkSvg } from '../../components/CoverArt';
import { SETTING_TEXT, type FormKey } from '../../workspaceMenu';

/**
 * The workspace menu's settings sections (Workspace, Guides, Features, Tasks, Calendar). They edit one shared draft
 * (WorkspaceMenu holds it), so moving between sections keeps what was typed and one Save sends it all.
 */

/** Number fields are edited as text, so a half-typed value is never coerced behind the person's back. */
export type NumKey = 'staleHours' | 'autoArchiveHours' | 'fallbackEffort';
export const NUM_KEYS: NumKey[] = ['staleHours', 'autoArchiveHours', 'fallbackEffort'];

export interface Form {
  /** The settings as they will be saved: stored values with the draft on top. */
  v: Settings;
  name: string;
  nums: Record<NumKey, string>;
  set: (p: Partial<Settings>) => void;
  setName: (n: string) => void;
  setNum: (k: NumKey, value: string) => void;
  /** Admins edit; everyone else reads. */
  editable: boolean;
}

const WEEKDAYS = [
  [1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [7, 'Sun', 'Sunday'],
] as const;

const text = (k: FormKey | 'name') => SETTING_TEXT[k];

/** Props a setting's control spreads: its id (for the label) and the explanation it is described by. */
export interface ControlProps { id: string; 'aria-describedby': string }

/** One setting: its label, a line saying what it does, then the control. Stacked, so it fits any width. */
export function Setting({ k, children, as = 'field' }: { k: FormKey | 'name'; children: (p: ControlProps) => ReactNode; as?: 'field' | 'fieldset' }) {
  const id = useId();
  const t = text(k);
  const p: ControlProps = { id: `${id}-c`, 'aria-describedby': `${id}-h` };
  if (as === 'fieldset') {
    return (
      <fieldset className="wsm-setting" aria-describedby={p['aria-describedby']}>
        <legend className="wsm-setting-label">{t.label}</legend>
        <p className="wsm-help" id={p['aria-describedby']}>{t.help}</p>
        {children(p)}
      </fieldset>
    );
  }
  return (
    <div className="wsm-setting">
      <label className="wsm-setting-label" htmlFor={p.id}>{t.label}</label>
      <p className="wsm-help" id={p['aria-describedby']}>{t.help}</p>
      {children(p)}
    </div>
  );
}

/** An on/off setting: label and explanation on the left, the switch on the right. */
export function SwitchSetting({ label, help, checked, disabled, onChange }: { label: string; help: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="wsm-switch-row">
      <div className="wsm-switch-text">
        <label htmlFor={id} className="wsm-setting-label">{label}</label>
        <p className="wsm-help" id={`${id}-d`}>{help}</p>
      </div>
      <span className="switch">
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={`${id}-d`}
          onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden className="track" />
      </span>
    </div>
  );
}

export function ReadOnlyNote() {
  return <p className="wsm-note">Only workspace admins can change these.</p>;
}

// ---------------------------------------------------------------- Workspace

export function WorkspaceForm({ f }: { f: Form }) {
  const art = f.v.coverArt;
  return (
    <div className="wsm-stack">
      <div className="wsm-identity">
        <span className="wsm-picture" aria-hidden>{art ? <ArtworkSvg id={art} /> : <span className="wsm-picture-empty">{(f.name || '?').slice(0, 1).toUpperCase()}</span>}</span>
        <div className="wsm-identity-text">
          {f.editable ? (
            <Setting k="name">{(p) => <input required maxLength={120} value={f.name} {...p} onChange={(e) => f.setName(e.target.value)} />}</Setting>
          ) : <h3 className="wsm-ws-name">{f.name}</h3>}
        </div>
      </div>
      {f.editable ? (
        <Setting k="description">{(p) => (
          <textarea rows={3} maxLength={1000} value={f.v.description} {...p} placeholder="What is this workspace for?"
            onChange={(e) => f.set({ description: e.target.value })} />
        )}</Setting>
      ) : f.v.description ? <p className="wsm-description">{f.v.description}</p> : <p className="muted">No description yet.</p>}
      {f.editable && (
        <Setting k="coverArt" as="fieldset">{() => (
          <div role="radiogroup" aria-label="Picture" className="wsm-art-grid">
            <button type="button" role="radio" aria-checked={art === null} className={art === null ? 'art-choice on wsm-art-none' : 'art-choice wsm-art-none'}
              onClick={() => f.set({ coverArt: null })}>None</button>
            {COVER_ARTWORKS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={art === a.id} aria-label={a.name} title={a.name}
                className={art === a.id ? 'art-choice on' : 'art-choice'} onClick={() => f.set({ coverArt: a.id })}>
                <ArtworkSvg id={a.id} />
              </button>
            ))}
          </div>
        )}</Setting>
      )}
      {!f.editable && <ReadOnlyNote />}
    </div>
  );
}

// ---------------------------------------------------------------- Guides

export function GuidesSection() {
  const onboarding = useStore((s) => s.onboarding);
  const account = useStore((s) => s.account);
  const meId = useStore((s) => s.me?.id);
  const paused = useTutorialPaused();
  const { done, skipped, chapter, doneCount, total } = questProgress({ onboarding, account });
  const finished = doneCount >= total;
  return (
    <div className="wsm-stack">
      <section className="wsm-card" aria-label="Tutorial">
        <div className="wsm-card-head">
          <div className="wsm-card-text">
            <h3 className="wsm-card-title">Tutorial</h3>
            <p className="wsm-help">Short steps that show you around: make a task, start it, invite someone… Each one ticks itself off when you do it.</p>
          </div>
        </div>
        <div className="wsm-card-foot">
          <span className="wsm-status" data-testid="tutorial-state">
            {finished ? 'Finished' : paused ? 'Paused' : 'Active'} · {doneCount} of {total} steps
          </span>
          {!finished && meId && (
            <button type="button" className="btn btn-sm" onClick={() => setTutorialPaused(meId, !paused)}>
              {paused ? 'Resume tutorial' : 'Pause tutorial'}
            </button>
          )}
        </div>
        {paused && !finished && <p className="wsm-help">Paused: its button is hidden from the top bar. Your progress is kept.</p>}
      </section>
      <ol className="wsm-parts" aria-label="Tutorial parts">
        {QUESTS.map((c, i) => {
          const open = c.steps.filter((s) => !skipped.has(s.key));
          const n = open.filter((s) => done.has(s.key)).length;
          const state = n === open.length ? 'Done' : i + 1 === chapter ? 'Now' : i + 1 < chapter ? 'Started' : 'Later';
          return (
            <li key={c.title} className={i + 1 === chapter ? 'wsm-part current' : 'wsm-part'}>
              <span className="wsm-part-num" aria-hidden>{toRoman(i + 1)}</span>
              <span className="wsm-part-text"><strong>{c.title}</strong><span className="wsm-help">{n} of {open.length} steps · {state}</span></span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- Features

const FEATURES: { key: FormKey; plan?: PlanFeature; get: (s: Settings) => boolean; set: (on: boolean) => Partial<Settings> }[] = [
  { key: 'milestonesEnabled', get: (s) => s.milestonesEnabled, set: (on) => ({ milestonesEnabled: on }) },
  { key: 'effortEnabled', get: (s) => s.effortEnabled, set: (on) => ({ effortEnabled: on }) },
  { key: 'sprintsEnabled', get: (s) => s.sprintsEnabled, set: (on) => ({ sprintsEnabled: on }) },
  { key: 'workflowMode', get: (s) => s.workflowMode === 'journeys', set: (on) => ({ workflowMode: on ? 'journeys' : null }) },
  { key: 'visionBoardEnabled', get: (s) => s.visionBoardEnabled, set: (on) => ({ visionBoardEnabled: on }) },
  { key: 'dueDateEnabled', plan: 'dueDates', get: (s) => s.dueDateEnabled, set: (on) => ({ dueDateEnabled: on }) },
  { key: 'timeTrackingMode', plan: 'timeTracking', get: (s) => s.timeTrackingMode !== null, set: (on) => ({ timeTrackingMode: on ? 'strict' : null }) },
  { key: 'dependenciesEnabled', plan: 'dependencies', get: (s) => s.dependenciesEnabled, set: (on) => ({ dependenciesEnabled: on }) },
];

export function FeaturesForm({ f }: { f: Form }) {
  const account = useStore((s) => s.account);
  return (
    <div className="wsm-stack">
      {FEATURES.map((ft) => {
        const t = text(ft.key);
        const pro = ft.plan && !featureAllowed(account ?? {}, ft.plan);
        return (
          <SwitchSetting key={ft.key} label={t.label} checked={ft.get(f.v)} onChange={(v) => f.set(ft.set(v))}
            help={pro ? `${t.help} Part of the Pro plan: what's there stays visible, adding new needs Pro.` : t.help} />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Tasks

export function TasksForm({ f }: { f: Form }) {
  const num = (k: NumKey) => ({
    type: 'number' as const, inputMode: 'numeric' as const, value: f.nums[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => f.setNum(k, e.target.value),
  });
  const archiveOn = f.v.autoArchiveHours !== null;
  return (
    <div className="wsm-stack">
      <h3 className="wsm-group">Size and priority</h3>
      <Setting k="effortScale">{(p) => (
        <select value={f.v.effortScale} {...p} onChange={(e) => f.set({ effortScale: e.target.value })}>
          <option value="linear">Counting: 0 to 10</option>
          <option value="fibonacci">Growing: 0, 1, 2, 3, 5, 8</option>
          <option value="exponential">Doubling: 0, 1, 2, 4, 8, 16</option>
        </select>
      )}</Setting>
      <Setting k="fallbackEffort">{(p) => <input {...num('fallbackEffort')} {...p} className="wsm-num" />}</Setting>
      <Setting k="priorityLabels" as="fieldset">{() => (
        <div className="wsm-trio">
          {(['a', 'b', 'c'] as const).map((k, i) => (
            <input key={k} aria-label={['Highest', 'Middle', 'Lowest'][i] + ' priority name'} value={f.v.priorityLabels[k]} maxLength={40}
              onChange={(e) => f.set({ priorityLabels: { ...f.v.priorityLabels, [k]: e.target.value } })} />
          ))}
        </div>
      )}</Setting>

      <h3 className="wsm-group">Keeping lists tidy</h3>
      <Setting k="staleHours">{(p) => <input {...num('staleHours')} {...p} className="wsm-num" />}</Setting>
      <Setting k="autoArchiveHours" as="fieldset">{() => (
        <div className="inline-options">
          <label className="radio">
            <input type="radio" name="wsm-archive" checked={!archiveOn} onChange={() => f.set({ autoArchiveHours: null })} />
            Never
          </label>
          <label className="radio">
            <input type="radio" name="wsm-archive" checked={archiveOn}
              onChange={() => f.set({ autoArchiveHours: Number(f.nums.autoArchiveHours) || DEFAULT_SETTINGS.autoArchiveHours })} />
            After
          </label>
          <input className="num-inline" aria-label="Hours until done tasks are archived" disabled={!archiveOn} {...num('autoArchiveHours')} />
          <span className="muted">hours</span>
        </div>
      )}</Setting>
      <SwitchSetting label={text('hideCompletedCounts').label} help={text('hideCompletedCounts').help} checked={f.v.hideCompletedCounts}
        onChange={(v) => f.set({ hideCompletedCounts: v })} />

      <h3 className="wsm-group">Pictures on tasks</h3>
      <Setting k="coverFromAttachments">{(p) => (
        <select value={f.v.coverFromAttachments} {...p} onChange={(e) => f.set({ coverFromAttachments: e.target.value })}>
          <option value="first">The first image attached</option>
          <option value="latest">The newest image attached</option>
          <option value="off">None (no pictures from attachments)</option>
        </select>
      )}</Setting>
      <SwitchSetting label={text('heroCoverFromSubs').label} help={text('heroCoverFromSubs').help} checked={f.v.heroCoverFromSubs}
        onChange={(v) => f.set({ heroCoverFromSubs: v })} />
    </div>
  );
}

// ---------------------------------------------------------------- Calendar

export function CalendarForm({ f }: { f: Form }) {
  return (
    <div className="wsm-stack">
      <Setting k="workdays" as="fieldset">{() => (
        <div className="day-toggles">
          {WEEKDAYS.map(([n, short, long]) => {
            const on = f.v.workdays.includes(n);
            return (
              <button key={n} type="button" className={on ? 'day on' : 'day'} aria-pressed={on} aria-label={long}
                onClick={() => f.set({ workdays: on ? f.v.workdays.filter((d) => d !== n) : [...f.v.workdays, n].sort() })}>
                {short}
              </button>
            );
          })}
        </div>
      )}</Setting>
      <Setting k="weekStart">{(p) => (
        <select value={f.v.weekStart} {...p} onChange={(e) => f.set({ weekStart: e.target.value })}>
          <option value="monday">Monday</option>
          <option value="sunday">Sunday</option>
          <option value="saturday">Saturday</option>
        </select>
      )}</Setting>
      <Setting k="timelineScale">{(p) => (
        <select value={f.v.timelineScale} {...p} onChange={(e) => f.set({ timelineScale: e.target.value })}>
          <option value="weeks">Weeks</option>
          <option value="days">Days</option>
        </select>
      )}</Setting>
    </div>
  );
}
