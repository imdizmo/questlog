/**
 * The workspace menu's sections (web/src/components/WorkspaceMenu.tsx): which exist, who sees them, how `?menu=` names
 * them, and where every option of the old Workspace settings dialog went. Pure data and functions, no React, so the
 * mapping is unit tested on its own (tests/web-workspace-menu.test.ts).
 */
import type { AccountSettings } from '../../shared/types';

export type SectionId =
  | 'workspace' | 'guides' | 'features' | 'tasks' | 'calendar' | 'types' | 'files' | 'members' | 'public' | 'connections'
  | 'look' | 'import' | 'export' | 'billing' | 'preferences' | 'archive' | 'disable';

/** Who may open a section: everyone signed in to the workspace, or admins (owner included). */
export type Access = 'all' | 'admin';

export interface SubTab { id: string; label: string }

export interface SectionDef {
  id: SectionId;
  label: string;
  /** Icon name of web/src/components/icons.tsx. */
  icon: string;
  /** One line under the section title: what lives here, in everyday words. */
  blurb: string;
  access: Access;
  /** Tabs inside the section; `?menu=<section>/<tab>` opens one. */
  tabs?: SubTab[];
  /** Kept apart at the bottom of the list (Archive, Disable). */
  bottom?: boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'workspace', label: 'Workspace', icon: 'globe', access: 'all', blurb: 'Its name, a short description and its picture.' },
  { id: 'guides', label: 'Guides', icon: 'guide', access: 'all', blurb: 'The step-by-step tutorial: see how far you are, pause it or pick it up again.' },
  { id: 'features', label: 'Features', icon: 'sliders', access: 'admin', blurb: 'Switch whole tools on or off for everyone in the workspace.' },
  { id: 'tasks', label: 'Tasks', icon: 'task', access: 'admin', blurb: 'How tasks are sized, ranked, archived and shown in lists.' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', access: 'admin', blurb: 'Working days and how the timeline counts time.' },
  { id: 'types', label: 'Entry types', icon: 'tag', access: 'all', blurb: 'The kinds of wiki entries (characters, items, places…) and what a new one starts with.' },
  { id: 'files', label: 'Files', icon: 'asset', access: 'all', blurb: 'Every file and picture attached to a task you can see.' },
  { id: 'members', label: 'Members', icon: 'people', access: 'admin', blurb: 'Who is in the workspace, their roles, invite links and people waiting to join.' },
  { id: 'public', label: 'Public links', icon: 'link', access: 'all', blurb: 'Projects anyone can read without an account, with their links.' },
  {
    id: 'connections', label: 'Connections', icon: 'plug', access: 'admin',
    blurb: 'Other tools that talk to this workspace: chat apps, code hosts, AI assistants, email and player reports.',
    tabs: [
      { id: 'mcp', label: 'AI assistants (MCP)' }, { id: 'discord', label: 'Discord' }, { id: 'slack', label: 'Slack' },
      { id: 'github', label: 'GitHub' }, { id: 'gitlab', label: 'GitLab' }, { id: 'bitbucket', label: 'BitBucket' },
      { id: 'steam', label: 'Steam' }, { id: 'reportsApi', label: 'Player reports over the web' },
      { id: 'reportsUnity', label: 'Player reports from Unity' }, { id: 'email', label: 'Email sending' },
    ],
  },
  { id: 'look', label: 'Look', icon: 'sun', access: 'all', blurb: 'Dark or light, on this device.' },
  {
    id: 'import', label: 'Import', icon: 'upload', access: 'admin', blurb: 'Bring tasks in from a spreadsheet or another tool, or copy projects.',
    tabs: [{ id: 'csv', label: 'Spreadsheet (CSV)' }, { id: 'trello', label: 'Trello' }, { id: 'hacknplan', label: 'HacknPlan' }, { id: 'copy', label: 'Copy projects' }],
  },
  { id: 'export', label: 'Export', icon: 'download', access: 'all', blurb: 'Take your data out: game data files and backups.' },
  { id: 'billing', label: 'Plan & billing', icon: 'star', access: 'admin', blurb: 'Your plan, seats and invoices.' },
  {
    id: 'preferences', label: 'Preferences', icon: 'user', access: 'all', blurb: 'Settings for you alone: emails, keys for scripts, sign-in.',
    tabs: [{ id: 'email', label: 'Emails to me' }, { id: 'tokens', label: 'API tokens' }, { id: 'account', label: 'Sign-in' }],
  },
  { id: 'archive', label: 'Archive', icon: 'archive', access: 'all', bottom: true, blurb: 'Archived projects and tasks, and deleted tasks you can still bring back.' },
  { id: 'disable', label: 'Disable workspace', icon: 'block', access: 'admin', bottom: true, blurb: 'Put the whole workspace to sleep. Nothing is deleted.' },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export interface Viewer { admin: boolean }

/** The sections this person sees, in list order. Admin-only sections are left out for everyone else. */
export function visibleSections(v: Viewer): SectionDef[] {
  return SECTIONS.filter((s) => s.access === 'all' || v.admin);
}

export function sectionById(id: string): SectionDef | undefined {
  return BY_ID.get(id as SectionId);
}

export interface MenuTarget { section: SectionId; tab: string | null }

/**
 * `?menu=<section>` or `?menu=<section>/<tab>` → where to open. null: the menu is closed. An unknown section, or one
 * this person may not open, opens the first section instead (a shared link never shows an admin page to a member); an
 * unknown tab opens the section's first tab.
 */
export function parseMenu(value: string | null, v: Viewer): MenuTarget | null {
  if (value === null) return null;
  const [id, tab] = value.split('/', 2);
  const visible = visibleSections(v);
  const s = visible.find((x) => x.id === id) ?? visible[0];
  const t = s.tabs?.find((x) => x.id === tab)?.id ?? s.tabs?.[0]?.id ?? null;
  return { section: s.id, tab: t };
}

/** The `?menu=` value for a section (and tab). */
export const menuValue = (section: SectionId, tab?: string | null): string => (tab ? `${section}/${tab}` : section);

/** Old `?show=` overlays that the menu replaced: where they open now (the old dialog's links and bookmarks). */
export function legacyMenu(show: string | null, query: URLSearchParams): string | null {
  if (show !== 'accountSettings') return null;
  return query.has('billing') ? 'billing' : 'workspace';
}

/** The next section for an arrow key in the section list (wraps around). */
export function stepSection(list: readonly SectionDef[], current: SectionId, key: string): SectionId | null {
  const i = list.findIndex((s) => s.id === current);
  if (key === 'ArrowDown') return list[(i + 1) % list.length].id;
  if (key === 'ArrowUp') return list[(i - 1 + list.length) % list.length].id;
  if (key === 'Home') return list[0].id;
  if (key === 'End') return list[list.length - 1].id;
  return null;
}

/**
 * Where each option of the old Workspace settings dialog lives now, with its new label and one-line explanation.
 * The sections render these texts (one source), the unit test checks that nothing was lost, and the report's table is
 * made from it.
 */
export interface OptionHome { old: string; section: SectionId; tab?: string; label: string; help: string }

/**
 * Settings that are stored but that nothing reads yet: the old dialog showed them with explanations of behaviour that
 * doesn't exist, so the menu leaves them out (their stored values are kept; only changed keys are ever saved).
 */
export const STORED_BUT_UNUSED = ['questLevel', 'defaultInboxDeckId'] as const;

/** Settings keys the menu edits through its shared form, by key (translationEnabled has its own switch with the pack's state). */
export type FormKey = Exclude<keyof AccountSettings, 'mcpEnabled' | 'mcpDailyLimit' | 'maxHandSlots' | 'translationEnabled' | (typeof STORED_BUT_UNUSED)[number]>;

export const SETTING_TEXT: Record<FormKey | 'name', OptionHome> = {
  name: { old: 'General › Workspace name', section: 'workspace', label: 'Name', help: 'Shown at the top left and in emails.' },
  description: { old: '(new)', section: 'workspace', label: 'Description', help: 'A few lines about the workspace, for everyone who opens this menu.' },
  coverArt: { old: '(new)', section: 'workspace', label: 'Picture', help: 'Shown next to the name in this menu.' },
  milestonesEnabled: { old: 'Features › Milestones', section: 'features', label: 'Milestones', help: 'Dated goals that collect the tasks needed to reach them.' },
  effortEnabled: { old: 'Features › Effort points', section: 'features', label: 'Effort points', help: 'A size on each task, added up per list, sprint and milestone. Off: progress counts tasks.' },
  sprintsEnabled: { old: 'Features › Sprints', section: 'features', label: 'Sprints', help: 'Repeating stretches of time (say two weeks) to plan the next bit of work.' },
  workflowMode: { old: 'Features › Task chains', section: 'features', label: 'Task chains', help: 'Reusable step lists that turn one task into a set of subtasks.' },
  visionBoardEnabled: { old: 'Features › Vision board', section: 'features', label: 'Vision board', help: 'A free canvas for ideas, sketches and the tasks they lead to.' },
  dueDateEnabled: { old: 'Features › Due dates', section: 'features', label: 'Due dates', help: 'A deadline on a single task, next to milestones and sprints.' },
  timeTrackingMode: { old: 'Features › Time tracking', section: 'features', label: 'Time tracking', help: 'A timer that runs while a task is started, plus time typed in by hand.' },
  dependenciesEnabled: { old: 'Features › Dependencies', section: 'features', label: 'Dependencies', help: 'Tasks that wait for other tasks to be done before they can start.' },
  effortScale: { old: 'General › Task properties › Effort scale', section: 'tasks', label: 'Effort sizes offered', help: 'The quick picks when you size a task. Any other number can still be typed in.' },
  priorityLabels: { old: 'General › Task properties › Priority labels', section: 'tasks', label: 'Priority names', help: 'What the three priority levels are called, highest first.' },
  staleHours: { old: 'General › Task properties › Stale after (hours)', section: 'tasks', label: 'Snooze untouched started tasks after (hours)', help: 'A started task nobody has changed for this long, with no open conversation, is shown as Snoozing.' },
  fallbackEffort: { old: 'General › Task properties › Fallback effort', section: 'tasks', label: 'Size of unsized tasks', help: 'Counted for a task that has no effort set, when lists add up their effort.' },
  autoArchiveHours: { old: 'General › Task properties › Archive done tasks', section: 'tasks', label: 'Archive done tasks', help: 'Done tasks move out of lists after this many hours. Nothing is deleted.' },
  hideCompletedCounts: { old: 'General › Lists › Hide done counts on list tiles', section: 'tasks', label: 'Hide done counts on list tiles', help: 'List tiles show only what is left to do, not how many tasks are done.' },
  coverFromAttachments: { old: 'General › Cover images › Cover image from attachments', section: 'tasks', label: 'Task picture from attachments', help: 'Which attached image becomes the picture on a task\'s tile.' },
  heroCoverFromSubs: { old: 'General › Cover images › Main tasks use their subtasks\' covers', section: 'tasks', label: 'Main tasks borrow subtask pictures', help: 'A main task without a picture of its own shows one from its subtasks.' },
  timelineScale: { old: 'General › Timeline › Scale', section: 'calendar', label: 'Timeline zoom', help: 'Whether the timeline opens showing weeks or single days.' },
  weekStart: { old: 'General › Timeline › Week starts on', section: 'calendar', label: 'Week starts on', help: 'The first day of each week on the timeline and in date pickers.' },
  workdays: { old: 'General › Timeline › Workdays', section: 'calendar', label: 'Working days', help: 'Used to count the working days left before a date.' },
};

/** The old dialog's other tabs (each its own panel), and where they went. */
export const TAB_HOMES: OptionHome[] = [
  { old: 'Billing', section: 'billing', label: 'Plan & billing', help: 'Your plan, seats and invoices.' },
  { old: 'Email', section: 'connections', tab: 'email', label: 'Email sending', help: 'How the server sends mail, and the newest emails it sent or tried to send.' },
  { old: 'API tokens', section: 'preferences', tab: 'tokens', label: 'API tokens', help: 'Keys that let scripts and other tools use the workspace as you (admins also see team keys).' },
  { old: 'MCP', section: 'connections', tab: 'mcp', label: 'AI assistants (MCP)', help: 'Lets an AI assistant read and change the workspace with your permission.' },
  { old: 'Discord', section: 'connections', tab: 'discord', label: 'Discord', help: 'Make tasks from Discord and post project news to a channel.' },
  { old: 'Slack', section: 'connections', tab: 'slack', label: 'Slack', help: 'Post project news to a Slack channel and add tasks with /addcard.' },
  { old: 'GitHub', section: 'connections', tab: 'github', label: 'GitHub', help: 'Commits that mention a task show up in its history.' },
  { old: 'GitLab', section: 'connections', tab: 'gitlab', label: 'GitLab', help: 'Commits that mention a task show up in its history.' },
  { old: 'BitBucket', section: 'connections', tab: 'bitbucket', label: 'BitBucket', help: 'Commits that mention a task show up in its history.' },
  { old: 'Steam', section: 'connections', tab: 'steam', label: 'Steam', help: 'Not connected yet; a note on what is planned.' },
  { old: 'CSV import', section: 'import', tab: 'csv', label: 'Spreadsheet (CSV)', help: 'Turn the rows of a spreadsheet into tasks.' },
  { old: 'Trello import', section: 'import', tab: 'trello', label: 'Trello', help: 'Bring in a Trello board from its export file.' },
  { old: 'HacknPlan import', section: 'import', tab: 'hacknplan', label: 'HacknPlan', help: 'Bring in a HacknPlan project from its export file.' },
  { old: 'Clone projects', section: 'import', tab: 'copy', label: 'Copy projects', help: 'Make copies of projects, with or without their tasks.' },
  { old: 'User reports via API', section: 'connections', tab: 'reportsApi', label: 'Player reports over the web', help: 'Your game or website sends bug reports and feedback that arrive as tasks.' },
  { old: 'User reports (Unity)', section: 'connections', tab: 'reportsUnity', label: 'Player reports from Unity', help: 'A Unity plugin that sends players\' bug reports in as tasks.' },
  { old: 'Danger Zone', section: 'disable', label: 'Disable workspace', help: 'Puts the workspace to sleep: nobody can sign in until the owner switches it back on. Nothing is deleted.' },
];

/** Every option of the old dialog with its new home: the settings first, then the panels. */
export const OPTION_HOMES: OptionHome[] = [...Object.values(SETTING_TEXT).filter((o) => o.old !== '(new)'), ...TAB_HOMES];
