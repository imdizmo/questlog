import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, type Route } from '../../router';
import { Mark, Icon } from '../../components/icons';
import { Dialog } from '../../components/Dialog';
import { showToast } from '../../toast';
import { openApi, openMessage, type PublicProject, type Viewer } from './api';
import { Gallery } from './Gallery';
import { CardPage, DeckPage, ProjectOverview } from './Pages';

/** What a page under a public project gets from the frame: the project, who is visiting, and the sign-in prompt. */
export interface OpenCtx {
  project: PublicProject;
  viewer: Viewer | null;
  /** Opens the sign-in / join dialog (an anonymous visitor tried to vote or subscribe). */
  askToJoin(): void;
  /** Reloads the project and the viewer (after signing in, subscribing, ...). */
  refresh(): void;
}

/** The public Open Decks pages (`/open/...`): rendered without the workspace store, for anyone. */
export function OpenApp({ route }: { route: Route }) {
  return (
    <div className="open-shell">
      {route.name === 'openGallery' && <><OpenTop /><Gallery /></>}
      {route.name === 'openConfirm' && <><OpenTop /><Confirm token={route.token} /></>}
      {(route.name === 'openProject' || route.name === 'openDeck' || route.name === 'openCard') && (
        <ProjectFrame key={route.urlName} urlName={route.urlName}>
          {(ctx) => route.name === 'openDeck' ? <DeckPage ctx={ctx} seq={route.seq} />
            : route.name === 'openCard' ? <CardPage ctx={ctx} code={route.code} />
              : <ProjectOverview ctx={ctx} />}
        </ProjectFrame>
      )}
    </div>
  );
}

function OpenTop({ children }: { children?: ReactNode }) {
  return (
    <header className="open-top">
      <Link href="/open" className="brand" aria-label="Public lists gallery"><Mark /><span className="brand-name">Public lists</span></Link>
      <div className="topbar-end">{children}</div>
    </header>
  );
}

function ProjectFrame({ urlName, children }: { urlName: string; children: (ctx: OpenCtx) => ReactNode }) {
  const [data, setData] = useState<{ project: PublicProject; viewer: Viewer | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const load = useCallback(() => {
    openApi.project(urlName).then((r) => { setData(r); setError(null); }).catch((e) => setError(openMessage(e)));
  }, [urlName]);
  useEffect(load, [load]);
  useEffect(() => { if (data) document.title = `${data.project.displayName} · Public lists`; }, [data]);

  if (error && !data) {
    return (
      <>
        <OpenTop />
        <main className="page open-page" id="main"><h1>Not found</h1><p className="muted">{error}</p><p><Link href="/open">Browse the gallery</Link></p></main>
      </>
    );
  }
  if (!data) return <><OpenTop /><main className="splash" id="main" aria-busy="true"><Mark size={40} /></main></>;
  const { project, viewer } = data;
  const signOut = async () => { try { await openApi.signOut(); } catch { /* gone either way */ } load(); };
  const ctx: OpenCtx = { project, viewer, askToJoin: () => setJoining(true), refresh: load };
  return (
    <>
      <OpenTop>
        {viewer ? (
          <>
            <span className="avatar" aria-hidden>{viewer.name.slice(0, 1).toUpperCase()}</span>
            <span className="me-name" data-testid="open-viewer">{viewer.name}</span>
            <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}><Icon name="logout" /></button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setJoining(true)}>Join or sign in</button>
        )}
      </OpenTop>
      {project.bannerUrl && <img className="open-banner" src={project.bannerUrl} alt="" data-testid="open-banner" />}
      <main className="page open-page" id="main">
        <div className="open-head">
          <p className="eyebrow"><Icon name="globe" size={14} /> <Link href={`/open/${project.urlName}`}>{project.displayName}</Link></p>
          {viewer && <Follow ctx={ctx} />}
        </div>
        {children(ctx)}
      </main>
      {joining && <JoinDialog urlName={project.urlName} onClose={() => setJoining(false)} onDone={() => { setJoining(false); load(); }} />}
    </>
  );
}

/** Update emails for this project: off, daily or weekly. */
function Follow({ ctx }: { ctx: OpenCtx }) {
  const [busy, setBusy] = useState(false);
  const set = async (v: 'daily' | 'weekly' | null) => {
    setBusy(true);
    try { await openApi.subscribe(ctx.project.id, v); ctx.refresh(); } catch (e) { showToast(openMessage(e)); } finally { setBusy(false); }
  };
  return (
    <label className="field open-follow">
      <span>Update emails</span>
      <select value={ctx.viewer?.subscription ?? ''} disabled={busy} onChange={(e) => void set((e.target.value || null) as 'daily' | 'weekly' | null)}>
        <option value="">Off</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>
    </label>
  );
}

/** Join (a guest account: name, email, password) or sign in, on the public pages. */
function JoinDialog({ urlName, onClose, onDone }: { urlName: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'join' | 'signIn'>('join');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'join') {
        await openApi.signUp({ name: name.trim(), email: email.trim(), password, urlName });
        setSent(true);
        return;
      }
      await openApi.signIn({ email: email.trim(), password });
      onDone();
    } catch (e) {
      setError(openMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (sent) {
    return (
      <Dialog title="Check your email" onClose={onClose} actions={
        <button type="button" className="btn btn-primary" onClick={() => { setSent(false); setMode('signIn'); }}>Sign in</button>
      }>
        <p>If {email.trim()} can be used, we sent it a link to finish signing up. It works for 24 hours.</p>
        <p className="hint">Once you have used the link, sign in here with your email and password.</p>
      </Dialog>
    );
  }
  return (
    <Dialog title={mode === 'join' ? 'Join to upvote and follow' : 'Sign in'} onClose={onClose} onSubmit={submit} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={() => { setMode(mode === 'join' ? 'signIn' : 'join'); setError(null); }}>
          {mode === 'join' ? 'I have an account' : 'Create an account'}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{mode === 'join' ? 'Join' : 'Sign in'}</button>
      </>
    }>
      {mode === 'join' && (
        <label className="field"><span>Name</span><input required maxLength={80} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} data-autofocus /></label>
      )}
      <label className="field"><span>Email</span><input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="field"><span>Password</span><input required type="password" minLength={mode === 'join' ? 8 : undefined} autoComplete={mode === 'join' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {mode === 'join' && <p className="hint">You can upvote tasks and get update emails. You won't see anything that isn't public.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Dialog>
  );
}

function Confirm({ token }: { token: string }) {
  const [state, setState] = useState<{ ok: true; urlName: string | null } | 'busy' | string>('busy');
  useEffect(() => { openApi.confirm(token).then((r) => setState(r)).catch((e) => setState(openMessage(e))); }, [token]);
  const done = typeof state === 'object';
  return (
    <main className="page open-page" id="main">
      <h1>{done ? 'You are signed up' : state === 'busy' ? 'Finishing your sign-up…' : 'Could not finish signing up'}</h1>
      <p className="muted">{done ? 'Sign in with your email and password to upvote tasks and get update emails.' : state === 'busy' ? '' : state}</p>
      <p>{done && state.urlName ? <Link href={`/open/${state.urlName}`}>Back to the project to sign in</Link> : <Link href="/open">Browse the gallery</Link>}</p>
    </main>
  );
}
