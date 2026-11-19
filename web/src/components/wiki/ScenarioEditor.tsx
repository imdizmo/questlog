import { useEffect, useMemo } from 'react';
import type { Card, FieldDef, NamedFormula, ScenarioClock, ScenarioValue } from '../../../../shared/types';
import { BALANCE_LIMITS, scenarioProblem } from '../../../../shared/balance';
import { useStore } from '../../store';
import { campaignLookup, checkScenario } from '../../balance';
import { FormulaInput, loadFormulaEditor } from './FormulaInput';
import { Block, moved, NameInput, replaced, RolesEditor, RowButtons, Unreadable, useBalanceDraft, useFieldChecks } from './balanceParts';
import { Icon } from '../icons';

const emptyScenario = (): ScenarioValue => ({ roles: [], state: [], clocks: [], end: 'false', cap: 60, measures: [] });
const named = (n: NamedFormula): NamedFormula => ({ name: n.name, formula: n.formula });
/** A stored scenario in exactly the shape the server takes (`first` only when set); null when it is not a scenario. */
export function readScenario(v: unknown): ScenarioValue | null {
  if (scenarioProblem(v) === 'wrong_kind') return null;
  const s = v as ScenarioValue;
  return {
    roles: s.roles.map((r) => ({ name: r.name, type: r.type })),
    state: s.state.map((x) => ({ name: x.name, start: x.start })),
    clocks: s.clocks.map((c) => ({ name: c.name, every: c.every, ...(c.first !== undefined ? { first: c.first } : {}), do: c.do.map(named) })),
    end: s.end, cap: s.cap,
    measures: s.measures.map(named),
  };
}

/**
 * A scenario field: roles, state with start values, clocks (first after, then every so many seconds, each tick
 * setting state in order), the end condition, a time cap and the measures read at the end. Every formula has
 * suggestions and plain-word problems; `time` (seconds since the start) can be read everywhere after the start.
 */
export function ScenarioEditor({ card, def, projectId, editable }: { card: Card; def: FieldDef; projectId: string; editable: boolean }) {
  const lookup = useStore((s) => campaignLookup(s, projectId));
  const d = useBalanceDraft(card, def, readScenario, emptyScenario);
  useEffect(() => { void loadFormulaEditor().catch(() => {}); }, []);
  const sc = d.draft;
  const check = useMemo(() => (sc ? checkScenario(sc, lookup) : null), [sc, lookup]);
  const extra = useFieldChecks(card, def, projectId, (rest) => /^(state |clock |end|measure |role |cap)/.test(rest));
  if (!sc || !check) return <Unreadable what="scenario" onReplace={d.replace} />;
  const set = (patch: Partial<ScenarioValue>) => d.set({ ...sc, ...patch });
  const setSave = (patch: Partial<ScenarioValue>) => d.setAndSave({ ...sc, ...patch });
  const save = () => d.save();
  const setClock = (i: number, c: ScenarioClock, now = false) => (now ? setSave : set)({ clocks: replaced(sc.clocks, i, c) });
  const formula = (label: string, value: string, f: { problems: import('../../../../shared/formula').FormulaProblem[] }, onChange: (v: string) => void, scope = check.scope) => (editable
    ? <FormulaInput label={label} value={value} scope={scope} problems={f.problems} onChange={onChange} onBlur={save} />
    : <code className="balance-read">{value}</code>);
  const stateNames = sc.state.map((s) => s.name).filter(Boolean);

  return (
    <div className="scenario-editor">
      <Block title="Roles">
        <RolesEditor roles={sc.roles} problems={check.roles} lookup={lookup} editable={editable} max={BALANCE_LIMITS.roles}
          onChange={(r) => set({ roles: r })} onSave={(r) => (r ? setSave({ roles: r }) : save())} />
      </Block>

      <Block title="State" hint={editable && !sc.state.length ? 'What changes during a run, with its start value: hp starts at target.hp, hits at 0.' : undefined}>
        <div className="balance-rows">
          {sc.state.map((s, i) => {
            const c = check.state[i];
            const label = s.name || `state ${i + 1}`;
            return (
              <div key={i} className="balance-row">
                {editable && <NameInput label={`State ${i + 1} name`} value={s.name} placeholder="hp" problem={c.name}
                  onChange={(n) => set({ state: replaced(sc.state, i, { ...s, name: n }) })} onBlur={save} />}
                <span className="balance-eq">{editable ? 'starts at' : `${s.name} starts at`}</span>
                {formula(`${label} starts at`, s.start, c.start, (v) => set({ state: replaced(sc.state, i, { ...s, start: v }) }), c.scope)}
                {editable && <RowButtons label={`state ${label}`} index={i} count={sc.state.length}
                  onMove={(to) => setSave({ state: moved(sc.state, i, to) })} onRemove={() => setSave({ state: sc.state.filter((_, j) => j !== i) })} />}
              </div>
            );
          })}
          {editable && sc.state.length < BALANCE_LIMITS.state && (
            <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => set({ state: [...sc.state, { name: '', start: '' }] })}><Icon name="plus" size={14} /> Add state</button>
          )}
        </div>
      </Block>

      <Block title="Clocks" hint="A clock ticks first after its first delay (or at once), then every so many seconds; each tick sets state in order, then the end condition is checked.">
        {sc.clocks.map((c, i) => {
          const k = check.clocks[i];
          const label = c.name || `clock ${i + 1}`;
          return (
            <div key={i} className="balance-clock" role="group" aria-label={`Clock ${label}`}>
              <div className="balance-row">
                {editable
                  ? <NameInput label={`Clock ${i + 1} name`} value={c.name} placeholder="swing" problem={k.name} onChange={(n) => setClock(i, { ...c, name: n })} onBlur={save} />
                  : <strong>{c.name}</strong>}
                {editable && <RowButtons label={`clock ${label}`} index={i} count={sc.clocks.length}
                  onMove={(to) => setSave({ clocks: moved(sc.clocks, i, to) })} onRemove={() => setSave({ clocks: sc.clocks.filter((_, j) => j !== i) })} />}
              </div>
              <div className="balance-row">
                <span className="balance-eq">first after</span>
                {c.first === undefined
                  ? <>
                      <span className="muted">at once</span>
                      {editable && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setClock(i, { ...c, first: '0' })}>Wait first</button>}
                    </>
                  : <>
                      {formula(`${label} first after`, c.first, k.first ?? { problems: [] }, (v) => setClock(i, { ...c, first: v }))}
                      <span className="muted">s</span>
                      {editable && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const { first: _drop, ...rest } = c; setClock(i, rest, true); }}>At once</button>}
                    </>}
              </div>
              <div className="balance-row">
                <span className="balance-eq">then every</span>
                {formula(`${label} every`, c.every, k.every, (v) => setClock(i, { ...c, every: v }))}
                <span className="muted">s</span>
              </div>
              <div className="balance-rows balance-updates">
                {c.do.map((u, j) => {
                  const uk = k.do[j];
                  const ulabel = `${label} sets ${u.name || `update ${j + 1}`}`;
                  return (
                    <div key={j} className="balance-row">
                      <span className="balance-eq">set</span>
                      {editable ? (
                        <select aria-label={`${label} update ${j + 1} sets`} value={u.name} aria-invalid={uk.name ? true : undefined} title={uk.name ?? undefined}
                          onChange={(e) => setClock(i, { ...c, do: replaced(c.do, j, { ...u, name: e.target.value }) }, true)}>
                          <option value="">Pick state…</option>
                          {stateNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          {u.name && !stateNames.includes(u.name) && <option value={u.name}>{u.name} (missing)</option>}
                        </select>
                      ) : <code>{u.name}</code>}
                      <span className="balance-eq">to</span>
                      {formula(ulabel, u.formula, uk.formula, (v) => setClock(i, { ...c, do: replaced(c.do, j, { ...u, formula: v }) }))}
                      {editable && <RowButtons label={`update ${j + 1} of ${label}`} index={j} count={c.do.length}
                        onMove={(to) => setClock(i, { ...c, do: moved(c.do, j, to) }, true)} onRemove={() => setClock(i, { ...c, do: c.do.filter((_, x) => x !== j) }, true)} />}
                    </div>
                  );
                })}
                {editable && c.do.length < BALANCE_LIMITS.updates && (
                  <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => setClock(i, { ...c, do: [...c.do, { name: '', formula: '' }] })}><Icon name="plus" size={14} /> Add update</button>
                )}
              </div>
            </div>
          );
        })}
        {editable && sc.clocks.length < BALANCE_LIMITS.clocks && (
          <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => set({ clocks: [...sc.clocks, { name: '', every: '', do: [] }] })}><Icon name="plus" size={14} /> Add clock</button>
        )}
      </Block>

      <Block title="End">
        <div className="balance-row">
          <span className="balance-eq">ends when</span>
          {formula('Ends when', sc.end, check.end, (v) => set({ end: v }))}
        </div>
        <div className="balance-row">
          <span className="balance-eq">or at</span>
          {editable ? (
            <input type="number" className="balance-cap" aria-label="Time cap" min={0} step="any" defaultValue={sc.cap} key={sc.cap}
              aria-invalid={check.cap ? true : undefined}
              onBlur={(e) => { const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n) && n > 0) setSave({ cap: n }); else e.target.value = String(sc.cap); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          ) : <span>{sc.cap}</span>}
          <span className="muted">s (the time cap)</span>
        </div>
      </Block>

      <Block title="Measures" hint={editable && !sc.measures.length ? 'Numbers read at the end of each run, for the simulator: hits, time (time to kill), …' : undefined}>
        <div className="balance-rows">
          {sc.measures.map((m, i) => {
            const c = check.measures[i];
            const label = m.name || `measure ${i + 1}`;
            return (
              <div key={i} className="balance-row">
                {editable
                  ? <NameInput label={`Measure ${i + 1} name`} value={m.name} placeholder="hits" problem={c.name} onChange={(n) => set({ measures: replaced(sc.measures, i, { ...m, name: n }) })} onBlur={save} />
                  : <strong>{m.name}</strong>}
                <span className="balance-eq">=</span>
                {formula(`Measure ${label}`, m.formula, c.formula, (v) => set({ measures: replaced(sc.measures, i, { ...m, formula: v }) }))}
                {editable && <RowButtons label={`measure ${label}`} index={i} count={sc.measures.length}
                  onMove={(to) => setSave({ measures: moved(sc.measures, i, to) })} onRemove={() => setSave({ measures: sc.measures.filter((_, j) => j !== i) })} />}
              </div>
            );
          })}
          {editable && sc.measures.length < BALANCE_LIMITS.measures && (
            <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => set({ measures: [...sc.measures, { name: '', formula: '' }] })}><Icon name="plus" size={14} /> Add measure</button>
          )}
        </div>
      </Block>

      {extra.length > 0 && (
        <Block title="Other problems">
          <ul className="formula-problems">{extra.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </Block>
      )}
    </div>
  );
}
