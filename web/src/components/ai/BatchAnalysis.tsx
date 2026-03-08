import { useState } from 'react';
import { BatchAnalysisResult, batchAnalyzeTasks } from '../../services/api';

interface Props {
  onBatchComplete: (result: BatchAnalysisResult) => void;
}

export default function BatchAnalysis({ onBatchComplete }: Props) {
  const [taskList, setTaskList] = useState('');
  const [result, setResult] = useState<BatchAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const tasks = taskList
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (tasks.length === 0) {
      setError('Add at least one task.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = await batchAnalyzeTasks(tasks);
      setResult(payload);
      onBatchComplete(payload);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Batch analysis failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-3">
      <textarea
        value={taskList}
        onChange={(event) => setTaskList(event.target.value)}
        className="min-h-32 w-full rounded-2xl border border-white/15 bg-black/15 p-3 text-white"
        placeholder="One task per line"
      />
      <button
        type="button"
        onClick={submit}
        disabled={loading}
        className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950"
      >
        {loading ? 'Analyzing batch...' : 'Analyze batch'}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {result ? (
        <ul className="space-y-2 text-sm text-white">
          {result.batch_results.map((entry) => (
            <li key={entry.task} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              {entry.task}: {entry.analyses.rag.quadrant_name}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
