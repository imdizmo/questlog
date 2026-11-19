import { useRef, useState, type ClipboardEvent } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { pictureKind, pictureRefusal, SUGGESTION_LIMITS, suggestionZip } from '../../../shared/suggestions';
import { sendSuggestion, type SuggestionTarget } from '../suggestions';
import { showToast } from '../toast';

interface Picture { id: number; data: Uint8Array }

const sizeText = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;
let nextId = 1;

/**
 * The top bar's Suggestion dialog: words (required) and up to ten screenshots, sent to the team's server only on
 * Send. A failed send keeps the dialog open with the words in it.
 */
export function SuggestionDialog({ target, onClose }: { target: SuggestionTarget; onClose: () => void }) {
  const [text, setText] = useState('');
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function';

  /** Adds pictures in order; each one that does not fit says why (the last reason stays on screen). */
  const add = (items: { name: string; data: Uint8Array }[]) => {
    let have = picturesRef.current;
    let why = '';
    for (const it of items) {
      if (!pictureKind(it.data)) { why = `${it.name} is not a PNG or JPEG picture: not added.`; continue; }
      const no = pictureRefusal(have.map((p) => p.data), it.data);
      if (no) { why = no; continue; }
      have = [...have, { id: nextId++, data: it.data }];
    }
    picturesRef.current = have;
    setPictures(have);
    setNote(why);
  };
  const addBlobs = async (blobs: { name: string; blob: Blob }[]) => {
    const items: { name: string; data: Uint8Array }[] = [];
    let why = '';
    for (const b of blobs) {
      // The size first: a picture that is too big is never read.
      if (b.blob.size > SUGGESTION_LIMITS.pictureBytes) { why = `${b.name} is over ${SUGGESTION_LIMITS.pictureBytes >> 20} MB: not added.`; continue; }
      items.push({ name: b.name, data: new Uint8Array(await b.blob.arrayBuffer()) });
    }
    add(items);
    if (why && !items.length) setNote(why);
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return; // text pastes into the box as usual
    e.preventDefault();
    void addBlobs(files.map((f) => ({ name: 'The pasted picture', blob: f })));
  };
  const pasteButton = async () => {
    try {
      const blobs: { name: string; blob: Blob }[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) blobs.push({ name: 'The pasted picture', blob: await item.getType(type) });
      }
      if (!blobs.length) { setNote('There is no picture on the clipboard.'); return; }
      await addBlobs(blobs);
    } catch {
      setNote('Questlog may not read the clipboard here. Press Ctrl+V in this window instead.');
    }
  };

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    setNote('Sending…');
    const why = await sendSuggestion(target, suggestionZip(text, pictures.map((p) => p.data)));
    setBusy(false);
    setNote('');
    if (why) { setError(why); return; }
    showToast('Sent, thank you.', 'info');
    onClose();
  };

  return (
    <Dialog title="Suggestion for Questlog" wide onClose={onClose} onSubmit={send}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy} title="Send your words and the pictures to your team's server.">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </>}>
      <div className="suggest" onPaste={onPaste}>
        <p>Tell the team what to improve, fix or add. It goes to your team's server with your name, the version of
          Questlog and the pictures below: nothing else.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="field">
          <span>Your suggestion</span>
          <textarea data-autofocus rows={8} maxLength={SUGGESTION_LIMITS.textChars} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="What would make Questlog better for you? What were you trying to do?" />
        </label>
        <div className="suggest-tools">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} title="Pick PNG or JPEG pictures from this computer.">
            Add screenshots…
          </button>
          {canPaste && <button type="button" className="btn" onClick={() => void pasteButton()} title="Add the picture on the clipboard (Ctrl+V works too).">Paste picture</button>}
          <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" multiple hidden aria-label="Screenshots"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = ''; // the same file can be picked again
              void addBlobs(files.map((f) => ({ name: f.name, blob: f })));
            }} />
          <span className="hint">You can also paste a picture with Ctrl+V.</span>
        </div>
        {pictures.length > 0 && (
          <ul className="suggest-list" aria-label="Pictures to send">
            {pictures.map((p, i) => (
              <li key={p.id}>
                <button type="button" className="icon-btn" aria-label={`Leave screenshot ${i + 1} out`} title="Leave this picture out."
                  onClick={() => { const next = picturesRef.current.filter((x) => x.id !== p.id); picturesRef.current = next; setPictures(next); setNote(''); }}>
                  <Icon name="close" size={14} />
                </button>
                <span>{`screenshot-${i + 1}.${pictureKind(p.data)} · ${sizeText(p.data.length)}`}</span>
              </li>
            ))}
          </ul>
        )}
        {note && <p className="hint" aria-live="polite">{note}</p>}
      </div>
    </Dialog>
  );
}
