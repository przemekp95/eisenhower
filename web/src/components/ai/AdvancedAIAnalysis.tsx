import { useState } from 'react';
import { applyAdvancedAnalysisResult, runAdvancedTaskAnalysis } from '../../lib/uiState';
import { analyzeWithLangChain, LangChainAnalysis } from '../../services/api';

interface Props {
  taskTitle: string;
  onAnalysisComplete: (analysis: LangChainAnalysis) => void;
}

export default function AdvancedAIAnalysis({ taskTitle, onAnalysisComplete }: Props) {
  const [analysis, setAnalysis] = useState<LangChainAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await runAdvancedTaskAnalysis(taskTitle, analyzeWithLangChain);
      applyAdvancedAnalysisResult(result, (analysis) => {
        setAnalysis(analysis);
        onAnalysisComplete(analysis);
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Analysis failed');
    } finally {
      setLoading(false);
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
        {loading ? 'Running analysis...' : 'Run advanced analysis'}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {analysis ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white">
          <p>{analysis.langchain_analysis.reasoning}</p>
          <p className="mt-2 text-white/70">
            Suggested quadrant: {analysis.langchain_analysis.quadrant ?? analysis.rag_classification.quadrant}
          </p>
        </div>
      ) : null}
    </section>
  );
}
