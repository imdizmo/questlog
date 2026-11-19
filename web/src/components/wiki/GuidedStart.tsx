// Guided start (redesign decision 10): making an entry of a type whose template has it on asks the name, then one
// question per Text, Lines and Steps block (Back, Skip), then makes the entry with the answers in place. Every "new
// entry" path goes through newEntry(); the Types page's "Try a new X" runs the same steps without making anything.
import { useEffect, useState } from 'react';
import { ASKED, BLOCK_LABELS, pageOf } from '../../../../shared/blocks';
import type { Block, EntryType, Project, TypePage } from '../../../../shared/types';
import { dispatch } from '../../api';
import { store } from '../../store';
import { Dialog } from '../Dialog';

export interface NewEntryRequest { project: Project; type: EntryType; name?: string; parentId?: string }
type Made = { id: string; key: string };

interface Open { req: NewEntryRequest; page: TypePage; dryRun: boolean; resolve: (r: Made | null) => void }
let show: ((o: Open | null) => void) | null = null;

/**
 * Makes a new entry of `type`: through the guided start when its template has it on (the dialog asks the name, with
 * `name` filled in, and the blocks), else at once with `name`. Resolves with the entry, or null when cancelled.
 */
export function newEntry(req: NewEntryRequest): Promise<Made | null> {
  const { page } = pageOf(store.get().entryTypes, req.type.id);
  const name = req.name?.trim();
  if (!page.guided || !show) {
    if (!name) return Promise.resolve(null);
    return dispatch<Made>('wiki', 'createEntry', { projectId: req.project.id, typeId: req.type.id, name, ...(req.parentId ? { parentId: req.parentId } : {}) });
  }
  const open = show;
  return new Promise((resolve) => open({ req, page, dryRun: false, resolve }));
}

/** "Try a new X": the guided steps (or, when off, the blocks a new page opens with) for a page being edited; nothing is made. */
export function tryNewEntry(req: NewEntryRequest, page: TypePage): void {
  show?.({ req, page, dryRun: true, resolve: () => {} });
}

/** Mounted once (App): hosts the dialog newEntry() opens. */
export function GuidedStartHost() {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => { show = setOpen; return () => { show = null; }; }, []);
  if (!open) return null;
  const finish = (r: Made | null) => { open.resolve(r); setOpen(null); };
  return <GuidedStart key={open.req.type.id} {...open} onDone={finish} />;
}

const asks = (b: Block) => ASKED.has(b.kind);

function GuidedStart({ req, page, dryRun, onDone }: Open & { onDone: (r: Made | null) => void }) {
  const { type, project } = req;
  const steps = page.blocks.filter(asks);
  const [i, setI] = useState(-1);
  const [name, setName] = useState(req.name ?? '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const what = type.name;
  const close = () => onDone(null);

  if (!page.guided) {
    return (
      <Dialog title={`A new ${what}`} onClose={close} actions={<button type="button" className="btn btn-primary" data-autofocus onClick={close}>Close</button>}>
        <div className="guide">
          <div className="gstep">Not guided</div>
          <h3>The page opens with these blocks</h3>
          <ul className="glist">{page.blocks.map((b) => <li key={b.id}>{b.title} <span className="bprompt">{BLOCK_LABELS[b.kind].toLowerCase()}{asks(b) && b.prompt ? `: ${b.prompt}` : ''}</span></li>)}</ul>
          <p className="hint">Turn on <b>Guided start</b> to ask these one at a time instead.</p>
        </div>
      </Dialog>
    );
  }

  const make = async () => {
    if (dryRun) { setI(steps.length); return; }
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      const r = await dispatch<Made>('wiki', 'createEntry', { projectId: project.id, typeId: type.id, name: name.trim(), answers: filled, ...(req.parentId ? { parentId: req.parentId } : {}) });
      onDone(r);
    } catch { setBusy(false); /* toast */ }
  };
  const next = () => {
    if (i < 0 && !name.trim()) return;
    if (i >= steps.length - 1) void make(); else setI(i + 1);
  };
  const title = name.trim() || `New ${what}`;

  if (i >= steps.length) {
    // Only a dry run gets here: what the entry would start with.
    return (
      <Dialog title={`Try a new ${what}`} onClose={close} actions={<button type="button" className="btn btn-primary" data-autofocus onClick={close}>Close</button>}>
        <div className="guide">
          <div className="gstep">Done <span className="ex">try</span></div>
          <h3>{title}</h3>
          <ul className="glist">{steps.map((b) => <li key={b.id}><b>{b.title}</b> {answers[b.id]?.trim() ? answers[b.id] : <span className="bprompt">left empty</span>}</li>)}</ul>
          <p className="hint">Nothing was made: a real new {what} opens in the Wiki with these answers in place.</p>
        </div>
      </Dialog>
    );
  }

  const b = i >= 0 ? steps[i] : null;
  const label = i < 0 ? `What is the ${what} called?` : b!.title;
  return (
    <Dialog title={dryRun ? `Try a new ${what}` : `New ${what}`} onClose={close} onSubmit={next}
      actions={<>
        {i < 0 ? <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
          : <>
            <button type="button" className="btn btn-ghost" onClick={() => setI(i - 1)}>Back</button>
            <button type="button" className="btn" onClick={() => { setAnswers({ ...answers, [b!.id]: '' }); if (i >= steps.length - 1) void make(); else setI(i + 1); }}>Skip</button>
          </>}
        <button type="submit" className="btn btn-primary" disabled={busy || (i < 0 && !name.trim())}>{i >= steps.length - 1 ? 'Make it' : 'Next'}</button>
      </>}>
      <div className="guide" data-testid="guided-start">
        <div className="gstep">{i < 0 ? `Guided start · ${steps.length + 1} short steps` : `Step ${i + 2} of ${steps.length + 1} · ${title}`}{dryRun && <span className="ex">try</span>}</div>
        <h3>{label}</h3>
        {i < 0
          ? <input key="name" data-autofocus autoFocus placeholder="A name" aria-label="Name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          : <>
            {b!.prompt && <p className="bprompt">{b!.prompt}</p>}
            {b!.kind !== 'text' && <p className="thint">{b!.kind === 'lines' ? 'One line each.' : 'One step per line.'}</p>}
            <textarea key={b!.id} autoFocus rows={5} aria-label={b!.title} value={answers[b!.id] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [b!.id]: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); next(); } }} />
            <span className="thint">Ctrl+Enter for the next step.</span>
          </>}
      </div>
    </Dialog>
  );
}
