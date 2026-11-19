import { taskId } from '../taskId';
import { useId, useRef, useState } from 'react';
import type { Priority } from '../../../shared/types';
import { cardCode, slugOf, titleOf } from '../../../shared/cards';
import { dispatch } from '../api';
import { settingsOf, store, useStore } from '../store';
import { usePageNavigate } from '../views/HomePane';
import { deckPath, pushRecentDeck } from '../cards';
import { showToast } from '../toast';
import { Dialog } from './Dialog';
import { DeckPicker } from './DeckPicker';
import { PriorityButtons } from './PriorityButtons';
import { EffortField } from './EffortField';
import { TagToggles } from './TagToggles';
import { eligibleOwners, OwnerPicker } from './OwnerPicker';
import { Editor } from './Editor';
import { LazyLoreEditor as LoreEditor } from '../lore/LazyLoreEditor';

/** A labelled on/off switch. */
export function Toggle({ label, checked, onChange, disabled, title }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string;
}) {
  return (
    <label className="toggle" title={title}>
      <span className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" />
      </span>
      <span>{label}</span>
    </label>
  );
}

/**
 * New card form (`?panel=add-card`). First line is the title; Ctrl+Enter saves.
 * Afterwards it opens the new card, unless "Create another" keeps the form open and empty.
 */
export function AddCardPanel({ deckId: initialDeck, onClose }: { deckId: string; onClose: () => void }) {
  const go = usePageNavigate(); // in the pane beside Home, it stays there
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const presets = useStore((s) => s.presets);
  const settings = useStore(settingsOf);
  const presetId = useId();
  const [preset, setPreset] = useState('');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [effort, setEffort] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [deckId, setDeckIdState] = useState(initialDeck);
  const deck = decks.get(deckId);
  const docDeck = deck?.deckType === 'doc';
  /** The text of a deck's default card, which new cards there start from (empty without one). */
  const templateText = (id: string) => {
    const tid = decks.get(id)?.defaultCardId;
    const t = tid ? store.get().cards.get(tid) : undefined;
    return t && t.deckId === id && t.visibility === 'default' ? t.content : '';
  };
  const [text, setText] = useState(() => templateText(initialDeck));
  /** Moving to another deck swaps in its default text, unless the person already changed the text. */
  const setDeckId = (id: string) => {
    if (text === templateText(deckId)) setText(templateText(id));
    setDeckIdState(id);
  };
  const [another, setAnother] = useState(false);
  const [isDocChoice, setIsDoc] = useState(docDeck);
  const isDoc = docDeck || isDocChoice;
  /** Once Lore was switched, the newly mounted editor leaves focus on the switch. */
  const [switched, setSwitched] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The text editor (the textarea, or the lore editor while Lore is on), for focusing it again. */
  const area = useRef<{ focus(): void } | null>(null);
  const empty = text.trim() === '';
  const projectTags = (deck && projects.get(deck.projectId)?.tags) || [];
  const presetList = [...presets.values()].sort((a, b) => a.name.localeCompare(b.name));

  /** A preset fills the property fields (and the text, if still empty or the default card's); they stay editable afterwards. */
  const pickPreset = (id: string) => {
    setPreset(id);
    const p = presets.get(id);
    if (!p) return;
    const d = p.data ?? {};
    if (d.priority !== undefined) setPriority(d.priority);
    if (d.effort !== undefined) setEffort(d.effort);
    if (d.masterTags) setTags(d.masterTags);
    // A saved owner who can't take cards in this project any more is skipped, like the server does.
    const project = deck ? projects.get(deck.projectId) : undefined;
    if (d.assigneeId && eligibleOwners(store.get(), project).some((u) => u.id === d.assigneeId)) setOwner(d.assigneeId);
    if (d.content && (!text.trim() || text === templateText(deckId))) setText(d.content);
  };

  const save = async () => {
    if (empty || busy || !deck) return;
    setBusy(true);
    const usePreset = !!preset && presets.has(preset);
    // Only the target project's tags; after a move to another project's deck the rest are dropped.
    const chosenTags = tags.filter((t) => projectTags.some((pt) => pt.name === t));
    try {
      const r = await dispatch<{ id: string; accountSeq: number }>('cards', 'create', {
        content: text, deckId, isDoc,
        ...(usePreset ? { presetId: preset } : {}),
        // With a preset the form shows its values, so send them all (edits win). Without one, send only what
        // was filled in, so the deck's default card still supplies the rest. Docs carry no priority or effort.
        ...(!isDoc && (usePreset || priority !== null) ? { priority } : {}),
        ...(!isDoc && (usePreset || effort !== null) ? { effort } : {}),
        ...(usePreset || chosenTags.length ? { masterTags: chosenTags } : {}),
        ...(!isDoc && (usePreset || owner !== null) ? { assigneeId: owner } : {}),
      });
      pushRecentDeck(deckId);
      if (another) {
        setText(templateText(deckId));
        showToast(`Added ${taskId({ seq: r.accountSeq, deckId })}`, 'info', 3000);
        area.current?.focus();
      } else {
        go(`${deckPath(deck)}/card/${cardCode(r.accountSeq)}-${slugOf(titleOf(text)) || 'card'}`);
      }
    } catch { /* toast */ } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New task" wide onClose={onClose} onSubmit={save} actions={<>
      <span className="hint foot-hint">Ctrl+Enter saves</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={empty || busy || !deck}>Add task</button>
    </>}>
      {/* The text lives here, so switching Lore on or off keeps it (the caret goes to the end). */}
      {isDoc ? (
        <LoreEditor
          editorRef={area} autoFocus={!switched} rows={8} placeholder="First line is the title"
          value={text} onChange={setText} onSave={() => void save()}
          projectId={deck?.projectId ?? null}
          onSetProperties={() => document.getElementById(presetId)?.focus()}
        />
      ) : (
        <Editor
          textareaRef={(el) => { area.current = el; }} autoFocus={!switched} rows={8} placeholder="First line is the title"
          value={text} onChange={setText} onSave={() => void save()}
          projectId={deck?.projectId ?? null}
          onSetProperties={() => document.getElementById(presetId)?.focus()}
        />
      )}
      <div className="add-options">
        <div className="quick-field">
          <span>List</span>
          <DeckPicker value={deckId} isDoc={isDoc} onChange={setDeckId} />
        </div>
        <Toggle label="Lore" checked={isDoc} disabled={docDeck} onChange={(v) => { setSwitched(true); setIsDoc(v); }}
          title={docDeck ? 'Everything in a lore list is lore' : undefined} />
        <Toggle label="Create another" checked={another} onChange={setAnother} />
      </div>
      <fieldset className="add-props">
        <legend className="sub">Properties</legend>
        <div className="quick-field">
          <label htmlFor={presetId}>Preset</label>
          <select id={presetId} className="quick-select" value={preset} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">None</option>
            {presetList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {!isDoc && (
          <>
            <OwnerPicker value={owner} project={deck ? projects.get(deck.projectId) : undefined} onChange={setOwner} />
            <PriorityButtons value={priority} settings={settings} onChange={setPriority} />
            <EffortField value={effort} settings={settings} onChange={setEffort} />
          </>
        )}
        <TagToggles tags={projectTags} value={tags} onChange={setTags} />
      </fieldset>
    </Dialog>
  );
}
