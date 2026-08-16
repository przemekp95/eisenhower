import { useEffect, useRef, useState } from 'react';
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
  const requestRef = useRef<AbortController | null>(null);
  const { t } = useLanguage();
  const quadrantLabels = {
    0: t('matrix.do'),
    1: t('matrix.delegate'),
    2: t('matrix.schedule'),
    3: t('matrix.delete'),
  };

  useEffect(
    () => () => {
      const request = requestRef.current;
      requestRef.current = null;
      request?.abort();
    },
    []
  );

  const updateTaskList = (value: string) => {
    const request = requestRef.current;
    requestRef.current = null;
    request?.abort();
    setLoading(false);
    setResult(null);
    setError(null);
    setTaskList(value);
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

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const payload = await batchAnalyzeTasks(tasks, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(payload);
      onBatchComplete(payload);
    } catch (issue) {
      if (controller.signal.aborted) return;
      const code = issue && typeof issue === 'object' && 'code' in issue ? issue.code : undefined;
      if (code !== 'request_cancelled') setError(t('ai.batch.failed'));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <section className="space-y-3">
      <textarea
        value={taskList}
        onChange={(event) => updateTaskList(event.target.value)}
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
              {resolveQuadrantLabel(entry.analyses.rag.quadrant, quadrantLabels, (quadrant) =>
                t('ai.manage.quadrantUnknown').replace('{quadrant}', String(quadrant))
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
