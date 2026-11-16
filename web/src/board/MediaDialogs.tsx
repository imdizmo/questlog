import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { imageSize, parseYouTube } from '../../../shared/board';
import { uploadFile } from '../api';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/icons';

/** What the server serves inline; anything else would upload but not show. */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const imageUrl = (fileId: string) => `/api/files/${encodeURIComponent(fileId)}`;

export interface ImageValue { url: string; width: number; height: number }

/** The size the browser decodes the file at; rejects for a file that is not an image. */
function naturalSize(file: File): Promise<{ width: number; height: number }> {
  const href = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(href); };
    img.onerror = () => { reject(new Error('not an image')); URL.revokeObjectURL(href); };
    img.src = href;
  });
}

/**
 * "Upload image": drop, paste or choose a file. It uploads to the host card (the image becomes one of its
 * attachments) and reports the node value; nothing is added to the board before the upload is done.
 */
export function ImageDialog({ hostCardId, onDone, onClose }: { hostCardId: string; onDone: (value: ImageValue) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!IMAGE_MIMES.includes(file.type)) { setError('Choose a PNG, JPEG, GIF or WebP image.'); return; }
    setBusy(true);
    setError('');
    try {
      const size = await naturalSize(file);
      const { id } = await uploadFile(hostCardId, file);
      // The value keeps the size capped at 400; newNodeAt sizes the node's box from it.
      const { w, h } = imageSize(size.width, size.height);
      onDone({ url: imageUrl(id), width: w, height: h });
    } catch {
      setBusy(false);
      setError("Couldn't upload that image.");
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void upload([...e.dataTransfer.files][0]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); void upload(file); }
  };

  return (
    <Dialog title="Upload image" onClose={onClose}>
      <div className={`drop-zone${over ? ' over' : ''}`} tabIndex={-1} data-autofocus
        onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)} onDrop={onDrop} onPaste={onPaste}>
        <Icon name="upload" size={20} />
        <span>Drop or paste an image, or</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => picker.current?.click()}>Choose file</button>
        <input ref={picker} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Choose image"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }} />
      </div>
      <p role="status" className="hint">{busy ? 'Uploading…' : ''}</p>
      {error && <p role="alert" className="field-error">{error}</p>}
    </Dialog>
  );
}

/** "Add YouTube video": a URL or an 11-character id. An invalid value shows the error and writes nothing. */
export function VideoDialog({ onDone, onClose }: { onDone: (videoId: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    const id = parseYouTube(text);
    if (id) onDone(id); else setError('That is not a YouTube link or video id.');
  };
  return (
    <Dialog title="Add YouTube video" onClose={onClose} onSubmit={submit}
      actions={<button type="submit" className="btn btn-primary">Add video</button>}>
      <label className="field">
        <span>YouTube URL or id</span>
        <input data-autofocus value={text} autoComplete="off" placeholder="https://www.youtube.com/watch?v=…"
          aria-invalid={error ? true : undefined} onChange={(e) => { setText(e.target.value); setError(''); }} />
      </label>
      {error && <p role="alert" className="field-error">{error}</p>}
    </Dialog>
  );
}
