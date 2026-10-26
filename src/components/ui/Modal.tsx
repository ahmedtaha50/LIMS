import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { t } from '../../i18n';

/**
 * The one overlay of the application (roadmap M24): a labelled modal dialog that
 *   - takes the focus when it opens (the `initialFocus` element, else the first control, else the dialog itself),
 *   - keeps Tab and Shift+Tab inside it (focus trap),
 *   - closes on Esc and on its close button, unless `dismissible` is false,
 *   - gives the focus back to the element that had it when it closes.
 *
 * `dismissible={false}` is for a dialog that must not vanish under the user, such as an e-signature once the password has been sent:
 * Esc does nothing and there is no close button until the caller allows it again.
 * `variant="drawer"` slides in from the left (the navigation on a narrow screen).
 */
const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Where Tab should go from `current` (index among `count` focusable elements), or null to let the browser move it. */
export function nextFocusIndex(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return -1;
  if (current === -1) return shift ? count - 1 : 0;
  if (!shift && current === count - 1) return 0;
  if (shift && current === 0) return count - 1;
  return null;
}

export interface ModalProps {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  /** Buttons at the bottom. */
  footer?: React.ReactNode;
  /** A sentence under the title (aria-describedby). */
  description?: React.ReactNode;
  dismissible?: boolean;
  initialFocus?: { current: HTMLElement | null };
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'center' | 'drawer';
  /** role="alertdialog" for a dialog that interrupts with something urgent. */
  role?: 'dialog' | 'alertdialog';
}

const WIDTH = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export function Modal({ open, title, onClose, children, footer, description, dismissible = true, initialFocus, size = 'md', variant = 'center', role = 'dialog' }: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const target = initialFocus?.current ?? (el?.querySelector(FOCUSABLE) as HTMLElement | null) ?? el;
    target?.focus();
    return () => {
      // Give the focus back, if the element is still on the page (a row that was re-rendered may be gone).
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: any) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // only the top-most dialog reacts
      if (latest.current.dismissible) latest.current.onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll(FOCUSABLE)).filter((n: any) => n.offsetParent !== null || n === document.activeElement) as HTMLElement[];
    const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    if (next === -1) panel.current.focus();
    else items[next].focus();
  };

  const drawer = variant === 'drawer';
  return (
    <div className={`fixed inset-0 z-50 flex ${drawer ? 'justify-start' : 'items-center justify-center p-4'}`}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" aria-hidden="true" onClick={() => { if (dismissible) onClose(); }} />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={drawer
          ? 'relative h-full w-72 max-w-[85vw] bg-slate-900 text-slate-200 shadow-2xl flex flex-col outline-none'
          : `relative bg-white rounded-2xl shadow-xl w-full ${WIDTH[size]} max-h-[90vh] flex flex-col overflow-hidden outline-none`}
      >
        <div className={`flex items-start justify-between gap-4 px-6 py-4 ${drawer ? 'border-b border-slate-800' : 'border-b border-slate-200 bg-slate-50'}`}>
          <div className="min-w-0">
            <h2 id={titleId} className={`text-lg font-bold ${drawer ? 'text-white' : 'text-slate-800'}`}>{title}</h2>
            {description && <p id={descId} className={`text-sm mt-0.5 ${drawer ? 'text-slate-400' : 'text-slate-600'}`}>{description}</p>}
          </div>
          {dismissible && <IconButton label={t('modal.close')} icon={<X className="w-5 h-5" />} onClick={onClose} className={drawer ? 'text-slate-300 hover:bg-slate-800' : ''} />}
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}
