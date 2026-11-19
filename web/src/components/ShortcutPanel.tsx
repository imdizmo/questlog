import { Dialog } from './Dialog';
import { SCOPE_LABEL, SHORTCUTS, type ShortcutScope } from '../shortcuts';

const SCOPES: ShortcutScope[] = ['global', 'deck', 'card', 'editor', 'board'];

/** Every registered shortcut, grouped by where it works. Entries that aren't wired yet are greyed. */
export function ShortcutPanel({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} scroll
      actions={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {SCOPES.map((scope) => (
        <section key={scope} className="shortcut-group">
          <h3>{SCOPE_LABEL[scope]}</h3>
          <ul className="shortcut-list">
            {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
              <li key={s.id} className={s.soon ? 'soon' : undefined}>
                <kbd>{s.keys}</kbd>
                <span>{s.label}</span>
                {s.soon && <span className="badge">Coming later</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
