import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { Card } from '../../../shared/types';
import { dispatch, uploadFile } from '../api';
import { useStore, type CardFile } from '../store';
import { formatTime } from '../cards';
import { formatSize } from '../relations';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './icons';

/** Shown inline (and as covers) by the server; everything else downloads. */
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;

/** The "Attachments" side tab: upload (button or drop), list with download and remove. */
export function AttachmentsTab({ card, editable }: { card: Card; editable: boolean }) {
  const files = useStore((s) => s.files);
  const users = useStore((s) => s.users);
  const list = useMemo(() => [...files.values()].filter((f) => f.cardId === card.id)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)), [files, card.id]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [removing, setRemoving] = useState<CardFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const off = !editable || card.visibility === 'deleted';

  /** One file after another, so a big upload never runs alongside others. */
  const upload = async (picked: File[]) => {
    for (const f of picked) {
      setUploading((u) => [...u, f.name]);
      try { await uploadFile(card.id, f); } catch { /* toast */ } finally {
        setUploading((u) => { const i = u.indexOf(f.name); return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)]; });
      }
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (off) return;
    const picked = [...e.dataTransfer.files];
    if (picked.length) void upload(picked);
  };

  return (
    <div className="attach-panel">
      {!off && (
        <div className={`drop-zone${over ? ' over' : ''}`}
          onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <Icon name="upload" size={20} />
          <span>Drop files here or</span>
          <button type="button" className="btn btn-sm" onClick={() => picker.current?.click()}>Upload files</button>
          <input ref={picker} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose files to upload"
            onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; if (picked.length) void upload(picked); }} />
        </div>
      )}
      <p role="status" className="hint">{uploading.length ? `Uploading ${uploading.join(', ')}…` : ''}</p>
      {list.length === 0 ? <p className="muted">No attachments yet.</p> : (
        <ul className="attach-list" aria-label="Attachments">
          {list.map((f) => {
            const who = f.uploaderId ? users.get(f.uploaderId)?.name : undefined;
            return (
              <li key={f.id} className="attach-item">
                {IMAGE.has(f.mime)
                  ? <img className="attach-thumb" src={fileUrl(f.id)} alt="" loading="lazy" data-testid="attachment-thumb" />
                  : <span className="attach-thumb attach-icon" aria-hidden><Icon name="file" size={20} /></span>}
                <div className="attach-text">
                  <a href={fileUrl(f.id)} download={f.name} className="attach-name" aria-label={`Download ${f.name}`}>{f.name}</a>
                  <span className="hint">
                    {formatSize(f.size)}{who ? ` · ${who}` : ''}{f.createdAt ? ` · ${formatTime(f.createdAt)}` : ''}
                  </span>
                </div>
                {f.id === card.coverFileId && <span className="badge">Cover</span>}
                {!off && (
                  <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => setRemoving(f)}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <ConfirmDialog title="Remove attachment?" confirmLabel="Remove" danger onClose={() => setRemoving(null)}
          onConfirm={() => dispatch('cards', 'removeFile', { fileId: removing.id })}>
          <p><strong>{removing.name}</strong> is deleted for everyone. This can't be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
