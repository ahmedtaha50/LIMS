import React, { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../../i18n';

type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: number;
  type: ToastType;
  message: string;
}

/** toast(message, type) as before, plus toast.error(message), toast.success(message) and toast.info(message). */
export interface ToastFn {
  (message: string, type?: ToastType): void;
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

interface ToastContextType {
  toast: ToastFn;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/** A failure stays long enough to be read and written down; it can also be dismissed. */
const LIFETIME_MS: Record<ToastType, number> = { success: 5000, info: 5000, error: 12000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setMessages(prev => prev.filter(m => m.id !== id)), []);

  const push = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++nextId.current;
    setMessages(prev => [...prev, { id, type, message }]);
    setTimeout(() => dismiss(id), LIFETIME_MS[type]);
  }, [dismiss]);

  // One function for the life of the provider: an effect that lists `toast` among its dependencies does not run again on every toast.
  const toast = useMemo<ToastFn>(() => Object.assign(
    (message: string, type?: ToastType) => push(message, type),
    { error: (message: string) => push(message, 'error'), success: (message: string) => push(message, 'success'), info: (message: string) => push(message, 'info') },
  ), [push]);
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 end-4 z-[60] flex flex-col gap-2 max-w-sm">
        {messages.map(m => (
          <div
            key={m.id}
            role={m.type === 'error' ? 'alert' : 'status'}
            aria-live={m.type === 'error' ? 'assertive' : 'polite'}
            className={`ps-4 pe-2 py-3 rounded-lg shadow-lg text-white font-medium text-sm transition-all animate-in fade-in slide-in-from-bottom-5 flex items-start gap-3 ${
              m.type === 'error' ? 'bg-red-600' :
              m.type === 'success' ? 'bg-emerald-600' : 'bg-slate-800'
            }`}
          >
            <span className="flex-1 break-words">{m.message}</span>
            <button type="button" onClick={() => dismiss(m.id)} aria-label={t('toast.dismiss')} className="p-1 rounded hover:bg-white/20 shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};
