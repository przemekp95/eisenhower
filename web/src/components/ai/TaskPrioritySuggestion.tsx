import { useEffect, useState } from 'react';
import { classifyTask, type ClassificationResult } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface TaskPriorityPatch {
  urgent: boolean;
  important: boolean;
}

interface Props {
  taskTitle: string;
  currentUrgent: boolean;
  currentImportant: boolean;
  onApply: (patch: TaskPriorityPatch) => Promise<void> | void;
}

function quadrantFromFlags(urgent: boolean, important: boolean) {
  if (urgent && important) return 0;
  if (urgent) return 1;
  if (important) return 2;
  return 3;
}

export default function TaskPrioritySuggestion({
  taskTitle,
  currentUrgent,
  currentImportant,
  onApply,
}: Props) {
  const [prediction, setPrediction] = useState<ClassificationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const { language, t } = useLanguage();

  useEffect(() => {
    setPrediction(null);
    setConfirming(false);
    setError(null);
    setStatus(null);
  }, [language, taskTitle]);

  const labels: Record<number, string> = {
    0: t('matrix.do'),
    1: t('matrix.delegate'),
    2: t('matrix.schedule'),
    3: t('matrix.delete'),
  };

  const suggest = async () => {
    setLoading(true);
    setPrediction(null);
    setConfirming(false);
    setError(null);
    setStatus(null);
    try {
      setPrediction(await classifyTask(taskTitle.trim()));
    } catch {
      setError(t('ai.priority.failed'));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await onApply({ urgent: prediction!.urgent, important: prediction!.important });
      setConfirming(false);
      setStatus(t('ai.priority.apply.success'));
    } catch {
      setError(t('ai.priority.apply.failed'));
    } finally {
      setApplying(false);
    }
  };

  const currentQuadrant = quadrantFromFlags(currentUrgent, currentImportant);

  return (
    <section className="space-y-3 border-b border-white/10 pb-5" aria-labelledby="priority-title">
      <div>
        <h3 id="priority-title" className="text-base font-semibold text-white">
          {t('ai.priority.title')}
        </h3>
        <p className="mt-1 text-sm leading-6 text-white/60">{t('ai.priority.description')}</p>
      </div>
      <button
        type="button"
        onClick={() => void suggest()}
        disabled={loading || !taskTitle.trim()}
        className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/8 disabled:cursor-wait disabled:opacity-50"
      >
        {loading ? t('ai.suggesting') : t('ai.suggest')}
      </button>
      {prediction ? (
        <div className="space-y-3 border-l-2 border-cyan-200/30 pl-4">
          <p className="text-sm font-medium text-white">
            {t('ai.priority.suggested').replace(
              '{quadrant}',
              labels[prediction.quadrant] ?? String(prediction.quadrant)
            )}
          </p>
          {prediction.requires_confirmation || prediction.confidence_status === 'low' ? (
            <p className="text-sm text-amber-100">{t('ai.priority.lowConfidence')}</p>
          ) : null}
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-full border border-cyan-200/30 px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10"
            >
              {t('ai.priority.apply.open')}
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-white">
                {labels[currentQuadrant]} → {labels[prediction.quadrant]}
              </p>
              <p className="text-xs leading-5 text-white/55">{t('ai.priority.apply.help')}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={applying}
                  className="rounded-full bg-cyan-200 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-50"
                >
                  {applying ? t('ai.priority.apply.applying') : t('ai.priority.apply.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setError(null);
                  }}
                  disabled={applying}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 transition hover:bg-white/8 disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-emerald-200">
          {status}
        </p>
      ) : null}
    </section>
  );
}
