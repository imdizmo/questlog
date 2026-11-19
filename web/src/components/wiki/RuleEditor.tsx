import { useEffect, useMemo, useState } from 'react';
import type { Card, FieldDef, RuleExample, RuleValue } from '../../../../shared/types';
import { balanceName, BALANCE_LIMITS, ruleProblem } from '../../../../shared/balance';
import { fieldsOf } from '../../../../shared/wiki';
import type { Value } from '../../../../shared/formula';
import { useStore } from '../../store';
import { campaignLookup, checkRule, newSeed, runExample, showValue, unitOfType, type ExampleStep, type Lookup } from '../../balance';
import { FormulaInput, loadFormulaEditor } from './FormulaInput';
import { Block, moved, NameInput, replaced, RolesEditor, RowButtons, Unreadable, useBalanceDraft, useFieldChecks } from './balanceParts';
import { Icon } from '../icons';

/** How long after the last keystroke the live example runs again. */
const EXAMPLE_DELAY_MS = 150;

const emptyRule = (): RuleValue => ({ roles: [], parts: [], result: '', examples: [] });
/** A stored rule in exactly the shape the server takes (no extra keys); null when it is not a rule. */
export function readRule(v: unknown): RuleValue | null {
  if (ruleProblem(v) === 'wrong_kind') return null;
  const r = v as RuleValue;
  return {
    roles: r.roles.map((x) => ({ name: x.name, type: x.type })),
    parts: r.parts.map((p) => ({ name: p.name, formula: p.formula })),
    result: r.result,
    examples: r.examples.map((e) => ({ roles: { ...e.roles }, seed: e.seed })),
  };
}

/** The name formulas call this rule by: the entry's key, or key.field when its type has several rules. */
export function useBalanceName(card: Card, def: FieldDef): string | undefined {
  const types = useStore((s) => s.entryTypes);
  if (!card.entryKey || !card.entryTypeId) return undefined;
  const several = fieldsOf(types, card.entryTypeId).filter((f) => !f.hidden && f.kind === def.kind).length > 1;
  return balanceName(card.entryKey, def.key, several);
}

/** The value of a part or the result as the live example shows it. */
function StepValue({ step, unit, label }: { step: ExampleStep | undefined; unit?: string; label: string }) {
  return (
    <output className={`balance-value${step?.problem ? ' bad' : ''}`} aria-label={label} title={step?.problem}>
      {step?.problem ? step.problem : showValue(step?.value, unit)}
    </output>
  );
}

const sameExample = (a: RuleExample, b: RuleExample) => a.seed === b.seed && JSON.stringify(Object.entries(a.roles).sort()) === JSON.stringify(Object.entries(b.roles).sort());

/**
 * A rule field: roles, named parts and a result, written as formulas with suggestions and plain-word problems, and a
 * live example beside them: pick an entry for each role and a seed, and every part's value and the result update as
 * you type. "Save as example" keeps the pick and seed; the export runs saved examples into golden samples.
 */
export function RuleEditor({ card, def, projectId, editable }: { card: Card; def: FieldDef; projectId: string; editable: boolean }) {
  const lookup = useStore((s) => campaignLookup(s, projectId));
  const name = useBalanceName(card, def);
  const d = useBalanceDraft(card, def, readRule, emptyRule);
  useEffect(() => { void loadFormulaEditor().catch(() => {}); }, []);
  const rule = d.draft;
  const check = useMemo(() => (rule ? checkRule(rule, lookup, name) : null), [rule, lookup, name]);

  // The live example: an entry per role (the first that fits, until one is picked) and a seed.
  const [picked, setPicked] = useState<Record<string, string>>(() => ({ ...(rule?.examples[0]?.roles ?? {}) }));
  const [seed, setSeed] = useState<number>(() => rule?.examples[0]?.seed ?? 1);
  const roles = rule?.roles ?? [];
  const pick: Record<string, string> = {};
  for (const r of roles) {
    const options = lookup.entriesOf(r.type);
    const p = Object.hasOwn(picked, r.name) ? picked[r.name] : undefined;
    const key = p && options.some((o) => o.key === p) ? p : options[0]?.key;
    if (key && r.name) pick[r.name] = key;
  }
  const pickKey = JSON.stringify(pick);
  // The example runs ~150 ms after typing stops (each run keeps its step budget), not on every keystroke; a new pick or
  // seed runs it at once.
  const [settled, setSettled] = useState(rule);
  useEffect(() => { const t = setTimeout(() => setSettled(rule), EXAMPLE_DELAY_MS); return () => clearTimeout(t); }, [rule]);
  const example = useMemo(() => {
    if (!settled) return null;
    const c = settled === rule && check ? check : checkRule(settled, lookup, name);
    return runExample(settled, c, pick, seed, lookup);
  }, [settled, pickKey, seed, lookup, name]);
  const extra = useFieldChecks(card, def, projectId, (rest) => /^(part |result:|role )/.test(rest));
  const samples = lookup.balance.rules.find((r) => r.name === name)?.samples ?? [];

  if (!rule || !check) return <Unreadable what="rule" onReplace={d.replace} />;
  const set = (patch: Partial<RuleValue>) => d.set({ ...rule, ...patch });
  const setSave = (patch: Partial<RuleValue>) => d.setAndSave({ ...rule, ...patch });
  const save = () => d.save();
  const resultUnit = unitOfType(check.result.type);
  const current: RuleExample = { roles: pick, seed };
  const saved = rule.examples.some((e) => sameExample(e, current));
  const canSave = !example?.blocked && roles.length > 0 && check.ok && !saved && rule.examples.length < BALANCE_LIMITS.examples;

  return (
    <div className="rule-editor">
      <Block title="Roles" hint={editable && !roles.length ? 'A role is a name for an entry the rule reads, like attacker (a Weapon) or target (a Creature).' : undefined}>
        <RolesEditor roles={roles} problems={check.roles} lookup={lookup} editable={editable} max={BALANCE_LIMITS.roles}
          onChange={(r) => set({ roles: r })} onSave={(r) => (r ? setSave({ roles: r }) : save())} />
      </Block>

      <div className="balance-example" role="group" aria-label="Live example">
        <span className="balance-example-title">Example</span>
        {roles.map((r, i) => r.name && (
          <label key={i} className="balance-example-pick">
            <span>{r.name}</span>
            <select aria-label={`Example ${r.name}`} value={pick[r.name] ?? ''} onChange={(e) => setPicked({ ...picked, [r.name]: e.target.value })}>
              {!lookup.entriesOf(r.type).length && <option value="">No {lookup.typeName(r.type) || 'entries'} yet</option>}
              {lookup.entriesOf(r.type).map((o) => <option key={o.key} value={o.key}>{o.title}</option>)}
            </select>
          </label>
        ))}
        <label className="balance-example-pick">
          <span>seed</span>
          <input type="number" className="balance-seed" aria-label="Example seed" min={0} max={0xffffffff} step={1} value={seed}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) setSeed(n); }} />
        </label>
        <button type="button" className="btn btn-sm btn-ghost" title="Another seed: other random draws" onClick={() => setSeed(newSeed())}>New seed</button>
        {editable && (
          <button type="button" className="btn btn-sm" disabled={!canSave}
            title={saved ? 'This example is saved' : !check.ok ? 'Fix the problems first' : undefined}
            onClick={() => setSave({ examples: [...rule.examples, { roles: { ...pick }, seed }] })}>
            {saved ? 'Saved as example' : 'Save as example'}
          </button>
        )}
        {example?.blocked && <span className="hint">{example.blocked}</span>}
      </div>

      <Block title="Parts" hint={editable && !rule.parts.length ? 'Parts are named steps (crit = chance(attacker.crit_chance)); later parts and the result can use them by name.' : undefined}>
        <div className="balance-rows">
          {rule.parts.map((p, i) => {
            const c = check.parts[i];
            const label = p.name || `part ${i + 1}`;
            return (
              <div key={i} className="balance-row">
                {editable ? (
                  <>
                    <NameInput label={`Part ${i + 1} name`} value={p.name} placeholder="name" problem={c.name}
                      onChange={(n) => set({ parts: replaced(rule.parts, i, { ...p, name: n }) })} onBlur={save} />
                    <span className="balance-eq" aria-hidden>=</span>
                    <FormulaInput label={`Part ${label} formula`} value={p.formula} scope={c.scope} problems={c.formula.problems}
                      onChange={(f) => set({ parts: replaced(rule.parts, i, { ...p, formula: f }) })} onBlur={save} />
                  </>
                ) : <code className="balance-read">{p.name} = {p.formula}</code>}
                <StepValue step={example?.parts[i]} unit={unitOfType(c.formula.type)} label={`Value of ${label}`} />
                {editable && <RowButtons label={`part ${label}`} index={i} count={rule.parts.length}
                  onMove={(to) => setSave({ parts: moved(rule.parts, i, to) })} onRemove={() => setSave({ parts: rule.parts.filter((_, j) => j !== i) })} />}
              </div>
            );
          })}
          {editable && rule.parts.length < BALANCE_LIMITS.parts && (
            <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => set({ parts: [...rule.parts, { name: '', formula: '' }] })}>
              <Icon name="plus" size={14} /> Add part
            </button>
          )}
        </div>
      </Block>

      <Block title="Result">
        <div className="balance-row">
          {editable
            ? <FormulaInput label="Result formula" value={rule.result} scope={check.resultScope} problems={check.result.problems}
                onChange={(f) => set({ result: f })} onBlur={save} />
            : <code className="balance-read">{rule.result}</code>}
          <StepValue step={example?.result} unit={resultUnit} label="Value of result" />
        </div>
      </Block>

      {extra.length > 0 && (
        <Block title="Other problems">
          <ul className="formula-problems">{extra.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </Block>
      )}

      {rule.examples.length > 0 && (
        <Block title="Saved examples" hint="The export runs each into a golden sample (the parts' values and the result), so the game's code can be checked against them.">
          <ul className="balance-examples">
            {rule.examples.map((e, i) => {
              const sample = samples.find((s) => sameExample(s, e));
              const who = Object.entries(e.roles).map(([r, k]) => `${r}: ${lookup.entriesOf(roles.find((x) => x.name === r)?.type ?? '').find((o) => o.key === k)?.title ?? k}`).join(', ');
              return (
                <li key={i}>
                  <span>{who} · seed {e.seed}</span>
                  <span className="muted"> → {sample ? showResult(sample.result, resultUnit) : 'not run (see the problems above)'}</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setPicked({ ...e.roles }); setSeed(e.seed); }}>Show</button>
                  {editable && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove example ${i + 1}`} onClick={() => setSave({ examples: rule.examples.filter((_, j) => j !== i) })}>Remove</button>}
                </li>
              );
            })}
          </ul>
        </Block>
      )}
    </div>
  );
}

const showResult = (v: Value, unit?: string) => showValue(v, unit);
