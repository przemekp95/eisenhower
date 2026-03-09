import { useEffect, useState } from 'react';
import { applyAdvancedAnalysisResult, runAdvancedTaskAnalysis } from '../../lib/uiState';
import { resolveQuadrantLabel, resolveSuggestedQuadrant } from '../matrixUtils';
import { analyzeWithLangChain, LangChainAnalysis } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  taskTitle: string;
  onAnalysisComplete: (analysis: LangChainAnalysis) => void;
  onAddToMatrix?: (analysis: LangChainAnalysis) => Promise<void> | void;
}

export default function AdvancedAIAnalysis({ taskTitle, onAnalysisComplete, onAddToMatrix }: Props) {
  const [analysis, setAnalysis] = useState<LangChainAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const { language, t } = useLanguage();

  const quadrantLabels = {
    0: t('matrix.do'),
    1: t('matrix.schedule'),
    2: t('matrix.delegate'),
    3: t('matrix.delete'),
  };

  useEffect(() => {
    setAnalysis(null);
    setError(null);
  }, [language, taskTitle]);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await runAdvancedTaskAnalysis(taskTitle, language, analyzeWithLangChain);
      applyAdvancedAnalysisResult(result, (analysis) => {
        setAnalysis(analysis);
        onAnalysisComplete(analysis);
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.analysis.failed'));
    } finally {
      setLoading(false);
    }
  };

  const addToMatrix = async (
    result: LangChainAnalysis,
    onSubmit: (analysis: LangChainAnalysis) => Promise<void> | void
  ) => {
    setAdding(true);

    try {
      await onSubmit(result);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.analysis.addFailed'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={runAnalysis}
        disabled={loading || !taskTitle.trim()}
        className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-slate-900"
      >
        {loading ? t('ai.analysis.running') : t('ai.analysis.run')}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {analysis ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white">
          <p>{analysis.langchain_analysis.reasoning}</p>
          <p className="mt-2 text-white/70">
            {t('ai.analysis.suggestedQuadrant').replace(
              '{quadrant}',
              resolveQuadrantLabel(
                resolveSuggestedQuadrant(analysis),
                quadrantLabels,
                (quadrant) => t('ai.manage.quadrantUnknown').replace('{quadrant}', String(quadrant))
              )
            )}
          </p>
          {onAddToMatrix ? (
            <button
              type="button"
              onClick={() => {
                void addToMatrix(analysis, onAddToMatrix);
              }}
              disabled={adding}
              className="mt-4 rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition-all hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-emerald-400"
            >
              {adding ? t('ai.analysis.adding') : t('ai.analysis.add')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
