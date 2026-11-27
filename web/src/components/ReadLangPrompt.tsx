import { useState } from 'react';
import { settingsOf, useStore } from '../store';
import { answerReadLangPrompt, READ_LANGS, wantsReadLangPrompt, type ReadLang } from '../translate';
import { Dialog } from './Dialog';

/**
 * Asked once, on the first page load after Translation was switched on, of someone who has not picked a reading
 * language: which language to read in. Any answer (or Esc, which keeps "as written") is remembered (pref
 * `translatePrompted`), so it is never asked again; My account › Reading language changes it later.
 */
export function ReadLangPrompt() {
  const on = useStore((s) => settingsOf(s).translationEnabled);
  // Decided once per page load, so switching Translation on mid-session doesn't pop this over the settings.
  const [ask, setAsk] = useState(() => on && wantsReadLangPrompt());
  if (!ask) return null;
  const answer = (l: ReadLang | null) => { answerReadLangPrompt(l); setAsk(false); };
  return (
    <Dialog title="Read in your language?" onClose={() => answer(null)} actions={
      READ_LANGS.map((l) => (
        <button key={l.value} type="button" className={l.value === 'original' ? 'btn btn-ghost' : 'btn btn-primary'} onClick={() => answer(l.value)}>{l.label}</button>
      ))
    }>
      <p>Task text, comments and Lore pages can be shown in your language, translated on this server. The original is always one click away, and editing always edits what was written.</p>
      <p className="hint">You can change this later under Preferences › Sign-in › Reading language.</p>
    </Dialog>
  );
}
