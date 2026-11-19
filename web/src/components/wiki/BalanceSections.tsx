import { useId, useMemo, useState } from 'react';
import type { Card, EntryType, FieldDef } from '../../../../shared/types';
import { useStore } from '../../store';
import { fieldsOf } from '../../../../shared/wiki';
import { RuleEditor } from './RuleEditor';
import { ScenarioEditor } from './ScenarioEditor';
import { SimulatorTab } from './SimulatorTab';

/** Rule and scenario fields get the page's width (their editors are too wide for the infobox). */
export const isWideField = (f: FieldDef) => f.kind === 'rule' || f.kind === 'scenario';

/** The entry's rule and scenario fields, each as a section of its own; a scenario has a Simulator tab. */
export function BalanceSections({ card, type, projectId, editable }: { card: Card; type: EntryType; projectId: string; editable: boolean }) {
  const types = useStore((s) => s.entryTypes);
  const defs = useMemo(() => fieldsOf(types, type.id).filter((f) => !f.hidden && isWideField(f)), [types, type.id]);
  if (!defs.length) return null;
  return (
    <div className="entry-sections balance-sections">
      {defs.map((f) => (
        <section key={f.key} className="balance-section" aria-label={f.label}>
          <h2 className="entry-section-title">{f.label} <span className="muted balance-kind">{f.kind}</span></h2>
          {f.help && <p className="hint">{f.help}</p>}
          {f.kind === 'rule'
            ? <RuleEditor card={card} def={f} projectId={projectId} editable={editable} />
            : <ScenarioTabs card={card} def={f} projectId={projectId} editable={editable} />}
        </section>
      ))}
    </div>
  );
}

function ScenarioTabs({ card, def, projectId, editable }: { card: Card; def: FieldDef; projectId: string; editable: boolean }) {
  const id = useId();
  const [tab, setTab] = useState<'scenario' | 'simulator'>('scenario');
  const tabs = [{ key: 'scenario' as const, label: 'Scenario' }, { key: 'simulator' as const, label: 'Simulator' }];
  return (
    <div className="side-tabs">
      <div role="tablist" aria-label={`${def.label} views`} className="tabs"
        onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = tab === 'scenario' ? 'simulator' : 'scenario'; setTab(n); document.getElementById(`${id}-tab-${n}`)?.focus(); } }}>
        {tabs.map((t) => (
          <button key={t.key} id={`${id}-tab-${t.key}`} type="button" role="tab" className="tab" aria-selected={tab === t.key}
            aria-controls={`${id}-panel`} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {/* Both stay mounted: a batch keeps running (and its results stay) while the scenario is edited. */}
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="tab-panel">
        <div hidden={tab !== 'scenario'}><ScenarioEditor card={card} def={def} projectId={projectId} editable={editable} /></div>
        <div hidden={tab !== 'simulator'}><SimulatorTab card={card} def={def} projectId={projectId} /></div>
      </div>
    </div>
  );
}
