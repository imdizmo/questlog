import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { Icon } from './icons';

interface Props {
  title: string;
  onClose: () => void;
  /** When given, the body is a form and Enter submits. */
  onSubmit?: () => void | Promise<void>;
  children: ReactNode;
  /** Buttons for the bottom row (the submit button goes here). */
  actions?: ReactNode;
  wide?: boolean;
  /** Long content: header and buttons stay put, only the body scrolls. */
  scroll?: boolean;
}

/**
 * Modal dialog on the native <dialog> element: focus is trapped, Esc closes,
 * the page behind is inert. Mount it to open it, unmount to close it.
 */
export function Dialog({ title, onClose, onSubmit, children, actions, wide, scroll }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    // showModal picks its own initial focus; an element marked data-autofocus wins over it.
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onSubmit?.();
  };

  const body = (
    <>
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">{children}</div>
      {actions && <footer className="dialog-foot">{actions}</footer>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={['dialog', wide && 'dialog-wide', scroll && 'dialog-scroll'].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {onSubmit ? <form onSubmit={submit}>{body}</form> : body}
    </dialog>
  );
}
