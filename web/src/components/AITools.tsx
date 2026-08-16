import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import GroundedAIAnalysis from './ai/GroundedAIAnalysis';
import TaskPrioritySuggestion from './ai/TaskPrioritySuggestion';
import BatchAnalysis from './ai/BatchAnalysis';
import ImageUpload from './ai/ImageUpload';
import type { OCRImportSummary } from './ai/ImageUpload';
import { BatchAnalysisResult, OCRResult } from '../services/api';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  taskTitle: string;
  taskDescription?: string;
  currentUrgent?: boolean;
  currentImportant?: boolean;
  initialTab?: Tab;
  onClose: () => void;
  onApplyDescription?: (description: string) => Promise<void> | void;
  onApplyQuadrant?: (patch: { urgent: boolean; important: boolean }) => Promise<void> | void;
  onOCRTasksExtracted?: (
    result: OCRResult,
    learnFromAccepted: boolean
  ) => Promise<OCRImportSummary | number | void> | OCRImportSummary | number | void;
}

type Tab = 'assistant' | 'ocr' | 'batch';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function AITools({
  taskTitle,
  taskDescription = '',
  currentUrgent = false,
  currentImportant = false,
  initialTab = 'assistant',
  onClose,
  onApplyDescription,
  onApplyQuadrant,
  onOCRTasksExtracted,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [lastSummary, setLastSummary] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { language, t } = useLanguage();

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyPaddingRight = document.body.style.paddingRight;
    const previouslyFocused = document.activeElement;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const dialog = dialogRef.current!;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current!.focus();

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.paddingRight = previousBodyPaddingRight;
      window.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [initialTab, onClose]);

  const format = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (result, [key, value]) => result.replace(`{${key}}`, String(value)),
      template
    );

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'assistant', label: t('ai.tabs.assistant') },
    { id: 'ocr', label: t('ai.tabs.ocr') },
    { id: 'batch', label: t('ai.tabs.batch') },
  ];

  const formatOcrImportedSummary = (count: number) => {
    if (language === 'pl') {
      const remainder10 = count % 10;
      const remainder100 = count % 100;

      if (count === 1) {
        return t('ai.summary.ocrImported.one');
      }

      if (remainder10 >= 2 && remainder10 <= 4 && !(remainder100 >= 12 && remainder100 <= 14)) {
        return format(t('ai.summary.ocrImported.few'), { count });
      }

      return format(t('ai.summary.ocrImported.other'), { count });
    }

    return count === 1
      ? t('ai.summary.ocrImported.one')
      : format(t('ai.summary.ocrImported.other'), { count });
  };

  const handleOCR = async (result: OCRResult, learnFromAccepted: boolean) => {
    const outcome = await onOCRTasksExtracted?.(result, learnFromAccepted);
    if (typeof outcome === 'number') {
      setLastSummary(formatOcrImportedSummary(outcome));
    }
    return outcome;
  };

  const handleBatch = (result: BatchAnalysisResult) => {
    setLastSummary(format(t('ai.summary.batch'), { count: result.summary.total_tasks }));
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/70 px-2 py-2 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex min-h-full justify-end">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-tools-title"
          aria-describedby="ai-tools-description"
          className="flex h-[calc(100vh-1rem)] max-h-[calc(100vh-1rem)] w-full max-w-2xl flex-col overflow-y-auto overscroll-contain rounded-[2rem] border border-white/10 bg-slate-900/95 text-white shadow-2xl sm:h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-2rem)]"
          onMouseDown={(event) => event.stopPropagation()}
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="sticky top-0 z-10 border-b border-white/10 bg-slate-900/95 px-4 pb-4 pt-4 backdrop-blur-xl sm:px-6 sm:pb-5 sm:pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="ai-tools-title" className="text-xl font-semibold">
                  {t('ai.modal.title')}
                </h2>
                <p id="ai-tools-description" className="text-sm text-white/60">
                  {t('ai.modal.subtitle')}
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                className="self-start rounded-full bg-white/10 px-4 py-2 text-sm transition-all hover:bg-white/15 hover:text-white"
              >
                {t('ai.modal.close')}
              </button>
            </div>
            <div
              className="mt-4 flex flex-wrap gap-2"
              role="tablist"
              aria-label={t('ai.modal.title')}
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`ai-tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`ai-panel-${tab.id}`}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const current = tabs.findIndex((item) => item.id === tab.id);
                    const direction = event.key === 'ArrowRight' ? 1 : -1;
                    const next = tabs[(current + direction + tabs.length) % tabs.length];
                    setActiveTab(next.id);
                    document.getElementById(`ai-tab-${next.id}`)?.focus();
                  }}
                  className={`rounded-full px-4 py-2 text-sm transition-all ${
                    activeTab === tab.id
                      ? 'bg-white text-slate-950 hover:bg-white/90'
                      : 'bg-white/10 text-white hover:bg-white/15 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="px-4 pb-4 pt-4 sm:px-6 sm:pb-6 sm:pt-5">
            {activeTab === 'assistant' ? (
              <div
                role="tabpanel"
                id="ai-panel-assistant"
                aria-labelledby="ai-tab-assistant"
                className="space-y-5"
              >
                <section className="rounded-3xl border border-cyan-200/15 bg-cyan-300/5 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100/70">
                    {t('ai.task.context')}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold">{taskTitle}</h3>
                  {taskDescription ? (
                    <p className="mt-1 text-sm leading-6 text-white/65">{taskDescription}</p>
                  ) : null}
                </section>
                <TaskPrioritySuggestion
                  taskTitle={taskTitle}
                  currentUrgent={currentUrgent}
                  currentImportant={currentImportant}
                  onApply={onApplyQuadrant ?? (() => undefined)}
                />
                <GroundedAIAnalysis
                  taskTitle={taskTitle}
                  taskDescription={taskDescription}
                  onApplyDescription={onApplyDescription}
                />
              </div>
            ) : null}
            {activeTab === 'ocr' ? (
              <div role="tabpanel" id="ai-panel-ocr" aria-labelledby="ai-tab-ocr">
                <ImageUpload onTasksExtracted={handleOCR} />
              </div>
            ) : null}
            {activeTab === 'batch' ? (
              <div role="tabpanel" id="ai-panel-batch" aria-labelledby="ai-tab-batch">
                <BatchAnalysis onBatchComplete={handleBatch} />
              </div>
            ) : null}
            {lastSummary ? (
              <p role="status" aria-live="polite" className="mt-4 text-sm text-emerald-200">
                {lastSummary}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
