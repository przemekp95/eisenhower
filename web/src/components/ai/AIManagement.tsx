import { useEffect, useState } from 'react';
import {
  AICapabilities,
  TrainingStats,
  addTrainingExample,
  clearTrainingData,
  getCapabilities,
  getExamplesByQuadrant,
  getTrainingStats,
  learnFromFeedback,
  retrainModel,
} from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  onModelUpdated: () => void;
}

const cardClass = 'rounded-3xl border border-white/10 bg-black/20 p-4';
const fieldClass = 'w-full rounded-2xl border border-white/15 bg-white/6 px-4 py-3 text-white outline-none transition-colors placeholder:text-white/35 focus:border-cyan-400/60';
const buttonClass = 'rounded-full px-4 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50';

export default function AIManagement({ onModelUpdated }: Props) {
  const { t } = useLanguage();
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [capabilities, setCapabilities] = useState<AICapabilities | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [examples, setExamples] = useState<Array<{ text: string; quadrant: number }>>([]);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [exampleText, setExampleText] = useState('');
  const [exampleQuadrant, setExampleQuadrant] = useState(2);
  const [feedbackTask, setFeedbackTask] = useState('');
  const [predictedQuadrant, setPredictedQuadrant] = useState(1);
  const [correctQuadrant, setCorrectQuadrant] = useState(0);
  const [examplesQuadrant, setExamplesQuadrant] = useState(0);
  const [preserveExperience, setPreserveExperience] = useState(true);
  const [keepDefaults, setKeepDefaults] = useState(true);

  const quadrants = [
    { value: 0, label: t('matrix.do') },
    { value: 1, label: t('matrix.schedule') },
    { value: 2, label: t('matrix.delegate') },
    { value: 3, label: t('matrix.delete') },
  ];

  const format = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (result, [key, value]) => result.replace(`{${key}}`, String(value)),
      template
    );

  const refreshStatus = async () => {
    const [statsResult, capabilitiesResult] = await Promise.allSettled([getTrainingStats(), getCapabilities()]);

    let failed = false;
    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value);
    } else {
      failed = true;
    }

    if (capabilitiesResult.status === 'fulfilled') {
      setCapabilities(capabilitiesResult.value);
    } else {
      failed = true;
    }

    if (failed) {
      throw new Error(t('ai.manage.failedLoadStats'));
    }
  };

  useEffect(() => {
    void refreshStatus().catch((issue) => {
      setError(issue instanceof Error ? issue.message : t('ai.manage.failedLoadStats'));
    });
  }, [t]);

  const runAction = async (
    actionKey: string,
    action: () => Promise<void>,
    successMessage: string,
    afterSuccess?: () => void
  ) => {
    setLoadingAction(actionKey);
    setError('');
    setMessage('');

    try {
      await action();
      await refreshStatus();
      afterSuccess?.();
      onModelUpdated();
      setMessage(successMessage);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.manage.actionFailed'));
    } finally {
      setLoadingAction(null);
    }
  };

  const loadExamples = async () => {
    setLoadingAction('examples');
    setError('');
    setMessage('');

    try {
      const response = await getExamplesByQuadrant(examplesQuadrant, 5);
      setExamples(response.examples);
      setMessage(
        format(t('ai.manage.loadedExamples'), {
          count: response.examples.length,
          quadrant: quadrants[examplesQuadrant].label,
        })
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.manage.failedLoadExamples'));
    } finally {
      setLoadingAction(null);
    }
  };

  const providerStates = capabilities
    ? [
        [t('ai.manage.provider.openai'), Boolean(capabilities.providers.openai)],
        [t('ai.manage.provider.vision'), Boolean(capabilities.providers.vision)],
        [t('ai.manage.provider.embeddings'), capabilities.providers.embeddings],
        [t('ai.manage.provider.tesseract'), Boolean(capabilities.providers.tesseract)],
      ]
    : [];

  return (
    <section className="space-y-4 text-sm text-white">
      <div className="grid gap-3 md:grid-cols-2">
        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-cyan-200/70">{t('ai.manage.trainingState')}</p>
          {stats ? (
            <div className="mt-3 space-y-2 text-white/80">
              <p className="text-2xl font-semibold text-white">{stats.total_examples}</p>
              <p>{t('ai.manage.totalExamples')}</p>
              <p className="text-white/55">
                {format(t('ai.manage.lastUpdated'), { date: new Date(stats.last_updated).toLocaleString() })}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-white/60">{t('ai.manage.waitingStats')}</p>
          )}
        </div>
        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-emerald-200/70">{t('ai.manage.providers')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {providerStates.length > 0 ? (
              providerStates.map(([label, enabled]) => (
                <span
                  key={label}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    enabled
                      ? 'border-emerald-400/35 bg-emerald-400/12 text-emerald-100'
                      : 'border-white/10 bg-white/6 text-white/50'
                  }`}
                >
                  {label}: {enabled ? t('ai.manage.on') : t('ai.manage.off')}
                </span>
              ))
            ) : (
              <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs text-white/50">
                {t('ai.manage.loadingProviders')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-cyan-200/70">{t('ai.manage.addTrainingExample')}</p>
          <div className="mt-3 space-y-3">
            <input
              value={exampleText}
              onChange={(event) => setExampleText(event.target.value)}
              className={fieldClass}
              placeholder={t('ai.manage.taskText')}
            />
            <select
              value={exampleQuadrant}
              onChange={(event) => setExampleQuadrant(Number(event.target.value))}
              className={fieldClass}
            >
              {quadrants.map((quadrant) => (
                <option key={quadrant.value} value={quadrant.value} className="bg-slate-950">
                  {quadrant.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`${buttonClass} bg-emerald-500 text-slate-950 hover:-translate-y-0.5 hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/20`}
              disabled={loadingAction !== null || exampleText.trim().length === 0}
              onClick={() =>
                void runAction(
                  'add-example',
                  () => addTrainingExample(exampleText.trim(), exampleQuadrant),
                  t('ai.manage.exampleAdded'),
                  () => {
                    setExampleText('');
                  }
                )
              }
            >
              {loadingAction === 'add-example' ? t('ai.manage.addingExample') : t('ai.manage.addExample')}
            </button>
          </div>
        </div>

        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-amber-200/70">{t('ai.manage.feedbackLoop')}</p>
          <div className="mt-3 space-y-3">
            <input
              value={feedbackTask}
              onChange={(event) => setFeedbackTask(event.target.value)}
              className={fieldClass}
              placeholder={t('ai.manage.feedbackTask')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                value={predictedQuadrant}
                onChange={(event) => setPredictedQuadrant(Number(event.target.value))}
                className={fieldClass}
              >
                {quadrants.map((quadrant) => (
                  <option key={`predicted-${quadrant.value}`} value={quadrant.value} className="bg-slate-950">
                    {t('ai.manage.predicted')}: {quadrant.label}
                  </option>
                ))}
              </select>
              <select
                value={correctQuadrant}
                onChange={(event) => setCorrectQuadrant(Number(event.target.value))}
                className={fieldClass}
              >
                {quadrants.map((quadrant) => (
                  <option key={`correct-${quadrant.value}`} value={quadrant.value} className="bg-slate-950">
                    {t('ai.manage.correct')}: {quadrant.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={`${buttonClass} bg-cyan-500 text-slate-950 hover:-translate-y-0.5 hover:bg-cyan-400 hover:shadow-lg hover:shadow-cyan-500/20`}
              disabled={loadingAction !== null || feedbackTask.trim().length === 0}
              onClick={() =>
                void runAction(
                  'feedback',
                  () => learnFromFeedback(feedbackTask.trim(), predictedQuadrant, correctQuadrant),
                  t('ai.manage.feedbackLearned'),
                  () => {
                    setFeedbackTask('');
                  }
                )
              }
            >
              {loadingAction === 'feedback' ? t('ai.manage.learningFeedback') : t('ai.manage.learnFeedback')}
            </button>
          </div>
        </div>

        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-violet-200/70">{t('ai.manage.maintenance')}</p>
          <div className="mt-3 space-y-3">
            <label className="flex items-center gap-3 text-white/75">
              <input
                type="checkbox"
                checked={preserveExperience}
                onChange={(event) => setPreserveExperience(event.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-transparent"
              />
              {t('ai.manage.preserveExperience')}
            </label>
            <label className="flex items-center gap-3 text-white/75">
              <input
                type="checkbox"
                checked={keepDefaults}
                onChange={(event) => setKeepDefaults(event.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-transparent"
              />
              {t('ai.manage.keepDefaults')}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={`${buttonClass} bg-violet-500 text-white hover:-translate-y-0.5 hover:bg-violet-400 hover:shadow-lg hover:shadow-violet-500/20`}
                disabled={loadingAction !== null}
                onClick={() =>
                  void runAction(
                    'retrain',
                    async () => {
                      await retrainModel(preserveExperience);
                    },
                    t('ai.manage.retrained')
                  )
                }
              >
                {loadingAction === 'retrain' ? t('ai.manage.retraining') : t('ai.manage.retrain')}
              </button>
              <button
                type="button"
                className={`${buttonClass} bg-white/10 text-white hover:bg-white/15 hover:text-white`}
                disabled={loadingAction !== null}
                onClick={() =>
                  void runAction(
                    'clear',
                    async () => {
                      const result = await clearTrainingData(keepDefaults);
                      setExamples([]);
                      setMessage(format(t('ai.manage.clearedRemaining'), { count: result.remaining_examples }));
                    },
                    t('ai.manage.cleared')
                  )
                }
              >
                {loadingAction === 'clear' ? t('ai.manage.clearing') : t('ai.manage.clearTrainingData')}
              </button>
            </div>
          </div>
        </div>

        <div className={cardClass}>
          <p className="text-xs uppercase tracking-[0.32em] text-white/60">{t('ai.manage.browseExamples')}</p>
          <div className="mt-3 space-y-3">
            <select
              value={examplesQuadrant}
              onChange={(event) => setExamplesQuadrant(Number(event.target.value))}
              className={fieldClass}
            >
              {quadrants.map((quadrant) => (
                <option key={`browse-${quadrant.value}`} value={quadrant.value} className="bg-slate-950">
                  {quadrant.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`${buttonClass} bg-white/10 text-white hover:bg-white/15 hover:text-white`}
              disabled={loadingAction !== null}
              onClick={() => {
                void loadExamples();
              }}
            >
              {loadingAction === 'examples' ? t('ai.manage.loadingExamples') : t('ai.manage.loadExamples')}
            </button>
            {examples.length > 0 ? (
              <ul className="space-y-2">
                {examples.map((example) => (
                  <li key={`${example.quadrant}-${example.text}`} className="rounded-2xl border border-white/10 bg-white/6 p-3">
                    <p className="font-medium text-white">{example.text}</p>
                    <p className="mt-1 text-xs text-white/45">
                      {quadrants[example.quadrant]?.label ??
                        format(t('ai.manage.quadrantUnknown'), { quadrant: example.quadrant })}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-white/50">{t('ai.manage.examplesPlaceholder')}</p>
            )}
          </div>
        </div>
      </div>

      {message ? <p className="text-sm text-emerald-200">{message}</p> : null}
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
    </section>
  );
}
