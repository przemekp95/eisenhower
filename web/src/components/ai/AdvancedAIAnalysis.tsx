import { useState } from 'react';
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
    if (!taskTitle.trim()) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await analyzeWithLangChain(taskTitle);
      setAnalysis(result);
      onAnalysisComplete(result);
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
        className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
