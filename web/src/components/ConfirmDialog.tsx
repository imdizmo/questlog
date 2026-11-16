import { useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Rejecting keeps the dialog open (the error toast is already shown). */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}

/** Yes/no question; Enter confirms, Esc cancels. */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} onSubmit={go} actions={<>
      {/* A destructive confirm starts on Cancel, so a stray Enter doesn't delete anything. */}
      <button type="button" className="btn btn-ghost" onClick={onClose} data-autofocus={danger ? '' : undefined}>Cancel</button>
      <button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy} data-autofocus={danger ? undefined : ''}>{confirmLabel}</button>
    </>}>
      {children}
    </Dialog>
  );
}
