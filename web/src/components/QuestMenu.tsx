import { useEffect, useRef, useState } from 'react';
import { QUESTS, toRoman } from '../../../shared/quests';
import { useStore } from '../store';
import { questProgress } from '../onboarding';

/** Top-bar button with the current card sprint (Roman numeral); opens the list of sprints and steps with check marks. */
export function QuestMenu() {
  const onboarding = useStore((s) => s.onboarding);
  const account = useStore((s) => s.account);
  const { done, skipped, chapter, doneCount, total } = questProgress({ onboarding, account });
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="menu-wrap quest-wrap" ref={wrap}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
      <button ref={button} type="button" className="quest-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Tutorial, part ${toRoman(chapter)}`} title={`Tutorial: ${doneCount} of ${total} done`} onClick={() => setOpen((o) => !o)}>
        Tutorial <span className="quest-count">{doneCount}/{total}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Tutorial" className="menu menu-right quest-pop">
          <p className="quest-sum">{doneCount} of {total} steps done</p>
          {QUESTS.map((c, i) => (
            <section key={c.title} aria-label={`Part ${toRoman(i + 1)}: ${c.title}`} className={i + 1 === chapter ? 'quest-chap current' : 'quest-chap'}>
              <h3>{toRoman(i + 1)}. {c.title}</h3>
              <ul>
                {c.steps.map((s) => (
                  <li key={s.key} className={done.has(s.key) ? 'done' : undefined} data-step={s.key} data-unavailable={skipped.has(s.key) && !done.has(s.key) ? '' : undefined}>
                    <span className="quest-check" aria-hidden>{done.has(s.key) ? '✓' : skipped.has(s.key) ? '–' : '○'}</span>
                    <span>
                      {s.title}
                      <small className="menu-hint">{s.hint}</small>
                      <span className="sr-only">{done.has(s.key) ? ' (done)' : skipped.has(s.key) ? ' (not on your plan)' : ' (to do)'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
