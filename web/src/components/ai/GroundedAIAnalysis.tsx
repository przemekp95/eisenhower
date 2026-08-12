import { useEffect, useState } from 'react';
import { answerKnowledge, KnowledgeAnswer } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  taskTitle: string;
}

const MODE_STYLES: Record<KnowledgeAnswer['status'], string> = {
  answered: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
  insufficient_evidence: 'border-slate-300/20 bg-slate-300/10 text-slate-100',
};

export default function GroundedAIAnalysis({ taskTitle }: Props) {
  const [result, setResult] = useState<KnowledgeAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { language, t } = useLanguage();

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [language, taskTitle]);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);

    try {
      setResult(await answerKnowledge(taskTitle, language));
    } catch {
      setResult(null);
      setError(t('ai.grounded.failed'));
    } finally {
      setLoading(false);
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

      <button
        type="button"
        onClick={() => void runAnalysis()}
        disabled={loading || !taskTitle.trim()}
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
            </div>
          )}

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
    </section>
  );
}
