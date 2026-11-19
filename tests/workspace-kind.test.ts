import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDb, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { goesTo, hostOf, workspaceKind } from '../shared/workspaceKind';
import { WorkspaceKindLine } from '../web/src/components/WorkspaceKindLine';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// The workspace strip's server and web side: /api/status says which workspace this is, the top bar shows it.
describe('workspaceKind', () => {
  it('is "This computer" when the desktop app set the label', () => {
    expect(workspaceKind({ JT_WORKSPACE_LABEL: 'This computer', JATIFY_TEAM_SERVER: 'http://nas:8780' }, 'x:1'))
      .toEqual({ kind: 'local', label: 'This computer' });
    expect(workspaceKind({ JT_WORKSPACE_LABEL: '  ' }, 'nas:8780')).toEqual({ kind: 'team', label: 'Team: nas:8780', host: 'nas:8780' });
  });

  it('names a team server by JATIFY_TEAM_SERVER, else the address it was reached at', () => {
    expect(workspaceKind({ JATIFY_TEAM_SERVER: 'http://team.example:8780/' }, 'localhost:8780'))
      .toEqual({ kind: 'team', label: 'Team: team.example:8780', host: 'team.example:8780' });
    expect(workspaceKind({ JATIFY_TEAM_SERVER: 'nas' }, 'x').label).toBe('Team: nas');
    expect(workspaceKind({}, '100.64.0.7:8780').label).toBe('Team: 100.64.0.7:8780');
    expect(workspaceKind({ JATIFY_TEAM_SERVER: '' }, undefined)).toEqual({ kind: 'team', label: 'Team: server', host: 'server' });
    expect(workspaceKind({}, 'h'.repeat(200)).label.length).toBeLessThanOrEqual(86);
  });

  it('hostOf takes URLs and bare hosts', () => {
    expect(hostOf('https://t.example/x?y')).toBe('t.example');
    expect(hostOf('[fd7a::5]:9000')).toBe('[fd7a::5]:9000');
    expect(hostOf('')).toBeNull();
    expect(hostOf('http://')).toBeNull();
  });

  it('the New project line', () => {
    expect(goesTo({ kind: 'local', label: 'This computer' })).toBe('Goes to: This computer');
    expect(goesTo({ kind: 'team', label: 'Team: nas:8780', host: 'nas:8780' })).toBe('Goes to: Team nas:8780');
  });
});

describe('the switcher\'s line under the workspace name (it replaced the badge)', () => {
  const html = (w: Parameters<typeof WorkspaceKindLine>[0]['workspace']) => renderToStaticMarkup(createElement(WorkspaceKindLine, { workspace: w }));
  it('says where the workspace is, and nothing before the server said', () => {
    expect(html(null)).toBe('');
    const local = html({ kind: 'local', label: 'This computer' });
    expect(local).toContain('>This computer</span>');
    expect(local).toContain('kept on this computer');
    expect(local).toContain('wsw-kind-local');
    const team = html({ kind: 'team', label: 'Team: nas:8780', host: 'nas:8780' });
    expect(team).toContain('>Team: nas:8780</span>');
    expect(team).toContain('kept on the team server nas:8780');
    // Text, never markup.
    expect(html({ kind: 'team', label: 'Team: <b>x</b>', host: '<b>x</b>' })).not.toContain('<b>');
  });
});

describe('GET /api/status workspace', () => {
  let db: Db;
  let app: FastifyInstance;
  beforeEach(async () => {
    _resetLimiter();
    db = openDb(':memory:');
    app = buildApp({ db, hosts: ['localhost:8780', 'nas:8780'] });
    await app.ready();
  });
  afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });
  const status = async (host: string) => (await app.inject({ method: 'GET', url: '/api/status', headers: { host } })).json();

  it('reports the desktop app\'s own server as This computer', async () => {
    vi.stubEnv('JT_WORKSPACE_LABEL', 'This computer');
    expect((await status('localhost:8780')).workspace).toEqual({ kind: 'local', label: 'This computer' });
  });

  it('reports a team server by its address', async () => {
    vi.stubEnv('JT_WORKSPACE_LABEL', '');
    vi.stubEnv('JATIFY_TEAM_SERVER', '');
    expect((await status('nas:8780')).workspace).toEqual({ kind: 'team', label: 'Team: nas:8780', host: 'nas:8780' });
    vi.stubEnv('JATIFY_TEAM_SERVER', 'http://team.example:8780');
    const s = await status('nas:8780');
    expect(s.workspace.label).toBe('Team: team.example:8780');
    expect(s.setup).toBe(false);
  });
});
