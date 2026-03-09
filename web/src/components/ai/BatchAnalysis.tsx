import { useState } from 'react';
import { resolveQuadrantLabel } from '../matrixUtils';
import { BatchAnalysisResult, batchAnalyzeTasks } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  onBatchComplete: (result: BatchAnalysisResult) => void;
}

export default function BatchAnalysis({ onBatchComplete }: Props) {
  const [taskList, setTaskList] = useState('');
  const [result, setResult] = useState<BatchAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useLanguage();
  const quadrantLabels = {
    0: t('matrix.do'),
    1: t('matrix.schedule'),
    2: t('matrix.delegate'),
    3: t('matrix.delete'),
  };

  const submit = async () => {
    const tasks = taskList
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (tasks.length === 0) {
      setError(t('ai.batch.validation'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = await batchAnalyzeTasks(tasks);
      setResult(payload);
      onBatchComplete(payload);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.batch.failed'));
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
        placeholder={t('ai.batch.placeholder')}
      />
      <button
        type="button"
        onClick={submit}
        disabled={loading}
        className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-all hover:-translate-y-0.5 hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/20 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:bg-amber-500"
      >
        {loading ? t('ai.batch.running') : t('ai.batch.run')}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {result ? (
        <ul className="space-y-2 text-sm text-white">
          {result.batch_results.map((entry) => (
            <li key={entry.task} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              {entry.task}:{' '}
              {resolveQuadrantLabel(
                entry.analyses.rag.quadrant,
                quadrantLabels,
                (quadrant) => t('ai.manage.quadrantUnknown').replace('{quadrant}', String(quadrant))
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
