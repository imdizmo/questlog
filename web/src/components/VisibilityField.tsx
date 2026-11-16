import type { ProjectVisibility } from '../../../shared/types';
import { planAllows, useStore } from '../store';

export function VisibilityField({ value, onChange }: { value: ProjectVisibility; onChange: (v: ProjectVisibility) => void }) {
  const limitedOk = useStore((s) => planAllows(s, 'limitedVisibility'));
  return (
    <fieldset className="choice-list compact">
      <legend>Who can see it</legend>
      <label className={value === 'full' ? 'choice selected' : 'choice'}>
        <input type="radio" name="visibility" checked={value === 'full'} onChange={() => onChange('full')} />
        <span className="choice-title">Full team</span>
        <span className="choice-blurb">Every member of the workspace.</span>
      </label>
      <label className={value === 'limited' ? 'choice selected' : 'choice'}>
        <input type="radio" name="visibility" checked={value === 'limited'} disabled={!limitedOk && value !== 'limited'} onChange={() => onChange('limited')} />
        <span className="choice-title">Limited</span>
        <span className="choice-blurb">Only admins and people you add.{!limitedOk && ' Part of the Pro plan.'}</span>
      </label>
    </fieldset>
  );
}
