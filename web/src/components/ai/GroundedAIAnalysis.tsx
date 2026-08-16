import { useEffect, useState } from 'react';
import { answerKnowledge, KnowledgeAnswer } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  taskTitle: string;
  taskDescription?: string;
  onApplyDescription?: (description: string) => Promise<void> | void;
}

const MODE_STYLES: Record<KnowledgeAnswer['status'], string> = {
  answered: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
  insufficient_evidence: 'border-slate-300/20 bg-slate-300/10 text-slate-100',
};

export default function GroundedAIAnalysis({
  taskTitle,
  taskDescription = '',
  onApplyDescription,
}: Props) {
  const [result, setResult] = useState<KnowledgeAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState(taskTitle);
  const [descriptionPreview, setDescriptionPreview] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const { language, t } = useLanguage();

  useEffect(() => {
    setResult(null);
    setError(null);
    setDescriptionPreview(null);
    setApplyError(null);
    setApplyStatus(null);
  }, [language, taskTitle]);

  useEffect(() => {
    setQuestion(taskTitle);
  }, [taskTitle]);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setDescriptionPreview(null);
    setApplyError(null);
    setApplyStatus(null);

    try {
      setResult(await answerKnowledge(question.trim(), language));
    } catch {
      setResult(null);
      setError(t('ai.grounded.failed'));
    } finally {
      setLoading(false);
    }
  };

  const prepareDescription = (answer: string) => {
    const existing = taskDescription.trim();
    setDescriptionPreview(existing ? `${existing}\n\n${answer}` : answer);
    setApplyError(null);
    setApplyStatus(null);
  };

  const applyDescription = async (description: string) => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApplyDescription!(description.trim());
      setDescriptionPreview(null);
      setApplyStatus(t('ai.grounded.apply.success'));
    } catch {
      setApplyError(t('ai.grounded.apply.failed'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="grounded-analysis-title">
      <div>
        <h3 id="grounded-analysis-title" className="text-base font-semibold text-white">
          {t('ai.grounded.title')}
        </h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-white/60">
          {t('ai.grounded.description')}
        </p>
      </div>

      <label className="block text-sm font-medium text-white/80">
        {t('ai.grounded.question')}
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-white/7 px-4 py-3 text-white outline-none transition focus:border-emerald-200/45 focus:bg-white/10 focus:ring-2 focus:ring-emerald-200/15"
        />
      </label>

      <button
        type="button"
        onClick={() => void runAnalysis()}
        disabled={loading || !question.trim()}
        className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? t('ai.grounded.running') : t('ai.grounded.run')}
      </button>

      {error ? (
        <p role="alert" className="text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {result ? (
        <div aria-live="polite" className="space-y-4" data-testid="grounded-result">
          <div className="flex flex-wrap items-center gap-2 border-y border-white/10 py-3">
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${MODE_STYLES[result.status]}`}
            >
              {t(`ai.grounded.mode.${result.status}`)}
            </span>
          </div>

          {result.status === 'insufficient_evidence' ? (
            <div className="border-l-2 border-slate-300/40 pl-4">
              <p className="font-medium text-white">{t('ai.grounded.noAnswer')}</p>
              <p className="mt-1 text-sm text-white/55">{t('ai.grounded.nextStep')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm leading-6 text-white">{result.answer}</p>
              {result.answer && onApplyDescription ? (
                <button
                  type="button"
                  onClick={() => prepareDescription(result.answer!)}
                  className="rounded-full border border-emerald-200/30 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-200/55 hover:bg-emerald-200/10"
                >
                  {t('ai.grounded.apply.open')}
                </button>
              ) : null}
            </div>
          )}

          {descriptionPreview !== null ? (
            <div className="border-y border-white/10 py-4">
              <label className="block text-sm font-medium text-white">
                {t('ai.grounded.apply.preview')}
                <textarea
                  value={descriptionPreview}
                  onChange={(event) => setDescriptionPreview(event.target.value)}
                  rows={5}
                  className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-white outline-none focus:border-cyan-200/45 focus:ring-2 focus:ring-cyan-200/15"
                />
              </label>
              <p className="mt-2 text-xs leading-5 text-white/55">{t('ai.grounded.apply.help')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void applyDescription(descriptionPreview)}
                  disabled={applying || !descriptionPreview.trim()}
                  className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-50"
                >
                  {applying ? t('ai.grounded.apply.applying') : t('ai.grounded.apply.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDescriptionPreview(null);
                    setApplyError(null);
                  }}
                  disabled={applying}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 transition hover:bg-white/8 hover:text-white disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : null}

          <div>
            <h4 className="text-sm font-semibold text-white">{t('ai.grounded.sources')}</h4>
            {result.citations.length > 0 ? (
              <ol className="mt-3 divide-y divide-white/10 border-y border-white/10">
                {result.citations.map((citation) => (
                  <li key={citation.chunk_id} className="py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-white">{citation.title}</p>
                    </div>
                    <blockquote className="mt-2 border-l border-cyan-200/30 pl-3 text-sm leading-6 text-white/70">
                      {citation.excerpt}
                    </blockquote>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm text-white/50">{t('ai.grounded.noSources')}</p>
            )}
          </div>
        </div>
      ) : null}

      {applyError ? (
        <p role="alert" className="text-sm text-red-200">
          {applyError}
        </p>
      ) : null}
      {applyStatus ? (
        <p role="status" className="text-sm text-emerald-200">
          {applyStatus}
        </p>
      ) : null}
    </section>
  );
}
