import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { COVER_ARTWORKS, COVER_MAX_BYTES, COVER_MIMES, type Cover } from '../../../shared/covers';
import { showToast } from '../toast';
import { ArtworkSvg, CoverArt } from './CoverArt';

/** What the picker holds: a cover, or a link the server will fetch when the form is saved. */
export type CoverChoice = Cover | { kind: 'url'; url: string };

/** The fields to send with decks/projects create or update for this choice. */
export const coverFields = (c: CoverChoice): { cover: Cover } | { coverUrl: string } =>
  c && c.kind === 'url' ? { coverUrl: c.url } : { cover: c };

const TABS = ['Artwork', 'Upload', 'Url', 'None'] as const;
type Tab = (typeof TABS)[number];

interface Props {
  projectId: string; value: CoverChoice; onChange: (c: CoverChoice) => void;
  /** Reports whether a cover upload is in flight, so the form can hold its Save button. */
  onBusy?: (busy: boolean) => void;
}

/** Uploads a cover image of the project; null (after a toast) when refused. */
export async function uploadCover(projectId: string, file: File): Promise<string | null> {
  if (!(COVER_MIMES as readonly string[]).includes(file.type)) { showToast('Covers must be a PNG, JPEG, GIF or WebP image.'); return null; }
  if (file.size > COVER_MAX_BYTES) { showToast(`That image is larger than ${COVER_MAX_BYTES / 1024 / 1024} MB.`); return null; }
  let res: Response;
  try {
    res = await fetch(`/api/covers?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file,
    });
  } catch { showToast("Couldn't upload the cover. Can't reach the server."); return null; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(res.status === 413 ? 'That image is too large.' : res.status === 415 ? 'Covers must be a PNG, JPEG, GIF or WebP image.' : `Couldn't upload the cover (${json?.error ?? res.status}).`);
    return null;
  }
  return (json as { id: string }).id;
}

/** Tabs Artwork, Upload, Url and None for choosing a deck or project cover. */
export function CoverPicker({ projectId, value, onChange, onBusy }: Props) {
  const base = useId();
  const [tab, setTab] = useState<Tab>(value?.kind === 'file' ? 'Upload' : 'Artwork');
  const [url, setUrl] = useState(value?.kind === 'url' ? value.url : '');
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => { setBusyState(b); onBusy?.(b); };
  // If the picker goes away mid-upload, the form must not stay locked.
  useEffect(() => () => onBusy?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (t: Tab) => {
    setTab(t);
    if (t === 'None') onChange(null);
  };
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    select(TABS[next]);
    document.getElementById(`${base}-tab-${TABS[next]}`)?.focus();
  };

  return (
    <div className="cover-picker">
      <span className="field-label">Cover</span>
      <div role="tablist" aria-label="Cover source" className="tabs" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`${base}-tab-${t}`} className="tab" aria-selected={tab === t}
            aria-controls={`${base}-panel`} tabIndex={tab === t ? 0 : -1} onClick={() => select(t)}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab}`} className="tab-panel cover-panel">
        {tab === 'Artwork' && (
          <div role="radiogroup" aria-label="Artwork" className="art-grid">
            {COVER_ARTWORKS.map((a) => {
              const on = value?.kind === 'art' && value.id === a.id;
              return (
                <button key={a.id} type="button" role="radio" aria-checked={on} aria-label={`Artwork ${a.id}: ${a.name}`}
                  title={a.name} className={on ? 'art-choice on' : 'art-choice'} onClick={() => onChange({ kind: 'art', id: a.id })}>
                  <ArtworkSvg id={a.id} />
                </button>
              );
            })}
          </div>
        )}
        {tab === 'Upload' && (
          <>
            <label className="field">
              <span>Cover image</span>
              <input type="file" accept={COVER_MIMES.join(',')} disabled={busy}
                onChange={async (e) => {
                  const input = e.currentTarget;
                  const f = input.files?.[0];
                  if (!f) return;
                  setBusy(true);
                  const id = await uploadCover(projectId, f);
                  setBusy(false);
                  if (id) onChange({ kind: 'file', fileId: id });
                  else input.value = '';
                }} />
              <small className="hint">PNG, JPEG, GIF or WebP, up to {COVER_MAX_BYTES / 1024 / 1024} MB.</small>
            </label>
            {value?.kind === 'file' && <CoverArt cover={value} size="tile" testId="cover-preview" />}
          </>
        )}
        {tab === 'Url' && (
          <label className="field">
            <span>Image link</span>
            <input type="url" value={url} placeholder="https://…" maxLength={2000}
              onChange={(e) => { setUrl(e.target.value); if (e.target.value.trim()) onChange({ kind: 'url', url: e.target.value.trim() }); }} />
            <small className="hint">The server fetches the image once when you save. Pick None to remove the cover.</small>
          </label>
        )}
        {tab === 'None' && <p className="hint">No cover.</p>}
      </div>
    </div>
  );
}
