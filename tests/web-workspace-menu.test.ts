import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  legacyMenu, menuValue, OPTION_HOMES, STORED_BUT_UNUSED, parseMenu, SECTIONS, sectionById, SETTING_TEXT, stepSection, TAB_HOMES, visibleSections,
} from '../web/src/workspaceMenu';
import { resolveLook } from '../web/src/look';

const admin = { admin: true };
const member = { admin: false };

describe('workspace menu sections and permissions', () => {
  it('lists every section for admins, in order, with ids unique', () => {
    const ids = visibleSections(admin).map((s) => s.id);
    expect(ids).toEqual(SECTIONS.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2)).toEqual(['workspace', 'guides']);
    expect(ids.slice(-2)).toEqual(['archive', 'disable']);
  });

  it('hides the admin sections from everyone else', () => {
    const ids = visibleSections(member).map((s) => s.id);
    expect(ids).toEqual(['workspace', 'guides', 'types', 'files', 'public', 'look', 'export', 'preferences', 'archive']);
    for (const hidden of ['features', 'tasks', 'calendar', 'members', 'connections', 'import', 'billing', 'disable']) expect(ids).not.toContain(hidden);
  });

  it('has the sections the spec names', () => {
    for (const id of ['workspace', 'guides', 'types', 'files', 'members', 'public', 'look', 'import', 'export', 'preferences', 'archive']) {
      expect(sectionById(id), id).toBeDefined();
    }
  });

  it('gives every section and tab a label and a one-line explanation', () => {
    for (const s of SECTIONS) {
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.blurb).toMatch(/\.$/);
      expect(s.blurb.length).toBeLessThan(140);
      for (const t of s.tabs ?? []) expect(t.label.length).toBeGreaterThan(2);
    }
  });
});

describe('?menu= deep links', () => {
  it('is closed without the parameter', () => {
    expect(parseMenu(null, admin)).toBeNull();
  });
  it('opens a section, and a tab of it', () => {
    expect(parseMenu('files', member)).toEqual({ section: 'files', tab: null });
    expect(parseMenu('connections/discord', admin)).toEqual({ section: 'connections', tab: 'discord' });
    expect(parseMenu('import', admin)).toEqual({ section: 'import', tab: 'csv' });
    expect(parseMenu('preferences/nope', member)).toEqual({ section: 'preferences', tab: 'email' });
  });
  it('sends unknown or forbidden sections to the first one', () => {
    expect(parseMenu('', admin)).toEqual({ section: 'workspace', tab: null });
    expect(parseMenu('nonsense', member)).toEqual({ section: 'workspace', tab: null });
    expect(parseMenu('members', member)).toEqual({ section: 'workspace', tab: null });
    expect(parseMenu('connections/email', member)).toEqual({ section: 'workspace', tab: null });
    expect(parseMenu('members', admin)).toEqual({ section: 'members', tab: null });
  });
  it('writes values back', () => {
    expect(menuValue('files')).toBe('files');
    expect(menuValue('import', 'trello')).toBe('import/trello');
  });
  it('maps the old Workspace settings links', () => {
    expect(legacyMenu('accountSettings', new URLSearchParams())).toBe('workspace');
    expect(legacyMenu('accountSettings', new URLSearchParams('billing=done'))).toBe('billing');
    expect(legacyMenu('members', new URLSearchParams())).toBeNull();
    expect(legacyMenu(null, new URLSearchParams())).toBeNull();
  });
});

describe('keyboard between sections', () => {
  const list = visibleSections(member);
  it('moves with the arrows and wraps', () => {
    expect(stepSection(list, 'workspace', 'ArrowDown')).toBe('guides');
    expect(stepSection(list, 'workspace', 'ArrowUp')).toBe('archive');
    expect(stepSection(list, 'archive', 'ArrowDown')).toBe('workspace');
    expect(stepSection(list, 'files', 'Home')).toBe('workspace');
    expect(stepSection(list, 'files', 'End')).toBe('archive');
    expect(stepSection(list, 'files', 'x')).toBeNull();
  });
});

describe('nothing of the old Workspace settings dialog is lost', () => {
  it('maps every stored setting the old form edited to a section', () => {
    // mcpEnabled / mcpDailyLimit live on the MCP panel (Connections); maxHandSlots never had a field in the dialog;
    // questLevel and defaultInboxDeckId are stored but nothing reads them, so the menu leaves them out.
    const elsewhere = new Set<string>(['mcpEnabled', 'mcpDailyLimit', 'maxHandSlots', ...STORED_BUT_UNUSED]);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (elsewhere.has(key)) continue;
      const home = SETTING_TEXT[key as keyof typeof SETTING_TEXT];
      expect(home, key).toBeDefined();
      expect(sectionById(home.section), key).toBeDefined();
    }
  });
  it('maps every old tab to a section (and tab) that exists', () => {
    const oldTabs = ['Billing', 'Email', 'API tokens', 'MCP', 'Discord', 'Slack', 'GitHub', 'GitLab', 'BitBucket', 'Steam', 'CSV import',
      'Trello import', 'HacknPlan import', 'Clone projects', 'User reports via API', 'User reports (Unity)', 'Danger Zone'];
    expect(TAB_HOMES.map((h) => h.old).sort()).toEqual([...oldTabs].sort());
    for (const h of TAB_HOMES) {
      const s = sectionById(h.section);
      expect(s, h.old).toBeDefined();
      if (h.tab) expect(s!.tabs?.some((t) => t.id === h.tab), h.old).toBe(true);
    }
  });
  it('leaves out the settings nothing reads', () => {
    expect(STORED_BUT_UNUSED).toEqual(['questLevel', 'defaultInboxDeckId']);
    for (const k of STORED_BUT_UNUSED) expect(k in SETTING_TEXT).toBe(false);
  });
  it('gives every option a label and a one-line plain explanation', () => {
    for (const o of OPTION_HOMES) {
      expect(o.label, o.old).not.toBe('');
      expect(o.help, o.old).toMatch(/\.$/);
      expect(o.help.length, o.old).toBeLessThan(140);
    }
  });
});

describe('look', () => {
  it('follows the computer only when asked to', () => {
    expect(resolveLook('dark', true)).toBe('dark');
    expect(resolveLook('light', false)).toBe('light');
    expect(resolveLook('system', true)).toBe('light');
    expect(resolveLook('system', false)).toBe('dark');
  });
});
