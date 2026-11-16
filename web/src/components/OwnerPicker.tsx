import { useId } from 'react';
import type { Project, User } from '../../../shared/types';
import { people, roleOf, useStore, type State } from '../store';

/** People who may own a card in this project: enabled, not observers, and able to see the project. */
export function eligibleOwners(s: State, project: Project | undefined): User[] {
  return people(s.users)
    .filter((u) => {
      if (u.disabled) return false;
      const role = roleOf(s, u.id);
      if (!role || role === 'observer') return false;
      if (!project || project.visibility === 'full' || role === 'owner' || role === 'admin') return true;
      return s.projectAccess.has(`${project.id}|${u.id}`);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function OwnerPicker({ value, project, onChange, disabled }: {
  value: string | null;
  project: Project | undefined;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
}) {
  const s = useStore((x) => x);
  const id = useId();
  const people = eligibleOwners(s, project);
  // Keep showing a current owner who has since lost access, so the select never lies.
  const current = value ? s.users.get(value) : undefined;
  if (current && !people.some((u) => u.id === current.id)) people.push(current);
  return (
    <div className="quick-field">
      <label htmlFor={id}>Owner</label>
      <select id={id} className="quick-select" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No owner</option>
        {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </div>
  );
}
