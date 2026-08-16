import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  clearAdminToken,
  getAdminRejection,
  getAdminToken,
  setAdminToken,
  subscribeToApiToken,
} from '../authSession';
import { useLanguage } from '../i18n/LanguageContext';
import AIManagement from './ai/AIManagement';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function AdminAccessPanel() {
  const { language } = useLanguage();
  const adminToken = useSyncExternalStore(subscribeToApiToken, getAdminToken, getAdminToken);
  const [credential, setCredential] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const pl = language === 'pl';
  const rejected = getAdminRejection() === 'rejected';

  useEffect(() => {
    if (!adminToken) inputRef.current?.focus();
  }, [adminToken]);

  if (!adminToken) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      setAdminToken(credential);
      setCredential('');
    };
    return (
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-white/10 p-4">
        <h3 className="font-semibold">{pl ? 'Dostęp administracyjny' : 'Administrator access'}</h3>
        <p className="text-sm leading-6 text-white/65">
          {pl
            ? 'Wpisz osobny kod administratora otrzymany od właściciela systemu. Ten kod służy wyłącznie do zarządzania i nie otwiera zadań użytkownika.'
            : 'Enter the separate administrator code provided by the system owner. It is used only for management and does not open user tasks.'}
        </p>
        {rejected ? (
          <p
            role="alert"
            className="rounded-xl border border-red-300/30 bg-red-950/40 p-3 text-sm text-red-100"
          >
            {pl
              ? 'Kod administratora jest nieprawidłowy lub wygasł. Sprawdź go albo skontaktuj się z właścicielem systemu.'
              : 'The administrator code is incorrect or has expired. Check it or contact the system owner.'}
          </p>
        ) : null}
        <label htmlFor="ai-admin-token" className="block text-sm">
          {pl ? 'Kod administratora' : 'Administrator code'}
        </label>
        <input
          ref={inputRef}
          id="ai-admin-token"
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3"
        />
        <button
          type="submit"
          disabled={!credential.trim()}
          className="rounded-full bg-cyan-300 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40"
        >
          {pl ? 'Otwórz administrację' : 'Open administration'}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => clearAdminToken()}
          className="rounded-full border border-white/15 px-4 py-2 text-sm"
        >
          {pl ? 'Zmień kod administratora' : 'Change administrator code'}
        </button>
      </div>
      <AIManagement onModelUpdated={() => undefined} />
    </div>
  );
}

export default function AIAdministrationDialog({ onClose }: { onClose: () => void }) {
  const { language } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pl = language === 'pl';

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (!focusable.length) return event.preventDefault();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    if (getAdminToken()) closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/75 p-2 sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-admin-title"
        className="mx-auto max-h-[calc(100vh-1rem)] w-full max-w-4xl overflow-y-auto rounded-[2rem] border border-white/10 bg-slate-900/95 p-4 text-white shadow-2xl sm:max-h-[calc(100vh-2rem)] sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-5 flex items-start justify-between gap-3 border-b border-white/10 pb-4">
          <div>
            <h2 id="ai-admin-title" className="text-xl font-semibold">
              {pl ? 'Administracja AI' : 'AI administration'}
            </h2>
            <p className="mt-1 text-sm text-white/60">
              {pl
                ? 'Konfiguracja modeli i stan systemu.'
                : 'Model configuration and system status.'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-4 py-2 text-sm"
          >
            {pl ? 'Zamknij' : 'Close'}
          </button>
        </header>
        <AdminAccessPanel />
      </div>
    </div>,
    document.body
  );
}
