import {useEffect, useId, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';

type Props = {title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string;modal?:boolean};

export function WorkspaceModal({title, children, onClose, wide = false, className = '',modal=true}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  const titleId = useId();
  close.current = onClose;

  useEffect(() => {
    if(!modal)return;
    opener.current=document.activeElement as HTMLElement|null;
    const before = opener.current;
    const dialog = root.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const input = dialog.querySelector<HTMLElement>('input:not(:disabled):not([type="file"]),textarea:not(:disabled),select:not(:disabled)');
      (input || dialog).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),a[href],summary,iframe,[tabindex="0"]',
      )).filter(item => item.tabIndex >= 0 && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
      const first = items[0], last = items.at(-1);
      if (!first) {event.preventDefault(); dialog.focus(); return;}
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialog && dialogs[dialogs.length - 1] === dialog && !dialog.contains(event.target as Node)) dialog.focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', keepFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', keepFocus);
      if (before?.isConnected) before.focus();
    };
  }, [modal]);

  return <div className={modal?'modal-overlay':'workspace-modal-inline'} onMouseDown={event => {if (modal&&event.target === event.currentTarget) event.preventDefault();}}>
    <div className={`modal workspace-modal ${wide ? 'wide' : ''} ${className}`} role={modal?'dialog':undefined} aria-modal={modal?true:undefined} aria-labelledby={modal?titleId:undefined} tabIndex={modal?-1:undefined} ref={root}>
      <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20}/></button></header>
      <div className="modal-body">{children}</div>
    </div>
  </div>;
}
