import { useRef, useState } from 'react';
import { quadrantToTaskState } from './matrixUtils';
import { batchAnalyzeTasks } from '../services/api';
import type { TaskInput } from '../types';
import { useLanguage } from '../i18n/LanguageContext';

type RowStatus = 'review' | 'duplicate-existing' | 'duplicate-batch' | 'created' | 'failed';

interface ReviewRow {
  id: string;
  title: string;
  quadrant: number;
  selected: boolean;
  operationKey: string;
  status: RowStatus;
}

interface Props {
  existingTitles: string[];
  onAddTask: (task: TaskInput, idempotencyKey?: string) => Promise<void>;
  onClose: () => void;
}

const normalizeTitle = (value: string) => value.trim().replace(/\s+/g, ' ');
const duplicateKey = (value: string) => normalizeTitle(value).toLocaleLowerCase();
const operationKey = (index: number) =>
  `web-bulk-import-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2)}`;

export default function BulkImport({ existingTitles, onAddTask, onClose }: Props) {
  const { language, t } = useLanguage();
  const [source, setSource] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const copy =
    language === 'pl'
      ? {
          title: 'Dodaj zadania zbiorczo',
          method: 'Kwadranty sugeruje ten sam klasyfikator MiniLM embedding + PyTorch/MLP.',
          source: 'Zadania do importu',
          classify: 'Klasyfikuj i sprawdź',
          classifying: 'Klasyfikuję…',
          review: 'Sprawdź przed importem',
          taskTitle: 'Tytuł zadania',
          quadrant: 'Kwadrant',
          existing: 'Już istnieje w macierzy',
          repeated: 'Powtórzone w tym imporcie',
          confirm: 'Potwierdź import',
          retry: 'Ponów nieudane',
          close: 'Zamknij',
          failed: 'Niepowodzenie',
          created: 'Dodano',
          empty: 'Wklej co najmniej jedno niepuste zadanie.',
          requestFailed: 'Nie udało się sklasyfikować listy.',
          result: (created: number, duplicates: number, failed: number) =>
            `Dodano ${created}. Pominięto duplikaty ${duplicates}. Nie udało się ${failed}.`,
        }
      : {
          title: 'Add tasks in bulk',
          method:
            'Quadrants are suggested by the same MiniLM embedding plus PyTorch/MLP classifier.',
          source: 'Tasks to import',
          classify: 'Classify and review',
          classifying: 'Classifying…',
          review: 'Review before import',
          taskTitle: 'Task title',
          quadrant: 'Quadrant',
          existing: 'Already in the matrix',
          repeated: 'Repeated in this import',
          confirm: 'Confirm import',
          retry: 'Retry failed',
          close: 'Close',
          failed: 'Failed',
          created: 'Created',
          empty: 'Paste at least one non-empty task.',
          requestFailed: 'The task list could not be classified.',
          result: (created: number, duplicates: number, failed: number) =>
            `Created ${created}. Skipped duplicates ${duplicates}. Failed ${failed}.`,
        };

  const classify = async () => {
    const tasks = source.split('\n').map(normalizeTitle).filter(Boolean);
    if (tasks.length === 0) {
      setError(copy.empty);
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    setSummary('');
    try {
      const result = await batchAnalyzeTasks(tasks, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const predictions = new Map(
        result.batch_results.map((entry) => [duplicateKey(entry.task), entry.analyses.rag.quadrant])
      );
      const existing = new Set(existingTitles.map(duplicateKey));
      const seen = new Set<string>();
      setRows(
        tasks.map((title, index) => {
          const key = duplicateKey(title);
          const status: RowStatus = existing.has(key)
            ? 'duplicate-existing'
            : seen.has(key)
              ? 'duplicate-batch'
              : 'review';
          seen.add(key);
          return {
            id: `${index}-${key}`,
            title,
            quadrant: predictions.get(key) ?? 3,
            selected: status === 'review',
            operationKey: operationKey(index),
            status,
          };
        })
      );
    } catch (issue) {
      if (!controller.signal.aborted) setError(copy.requestFailed);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const updateRow = (id: string, patch: Partial<ReviewRow>) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              status: patch.title !== undefined && row.status !== 'created' ? 'review' : row.status,
            }
          : row
      )
    );
  };

  const persist = async (failedOnly: boolean) => {
    setImporting(true);
    setError('');
    const candidates = rows.filter((row) =>
      failedOnly ? row.status === 'failed' : row.selected && row.status === 'review'
    );
    const nextRows = [...rows];
    for (const candidate of candidates) {
      const index = nextRows.findIndex((row) => row.id === candidate.id);
      const title = normalizeTitle(candidate.title);
      if (!title) continue;
      try {
        await onAddTask(
          { title, description: '', ...quadrantToTaskState(Number(candidate.quadrant)) },
          candidate.operationKey
        );
        nextRows[index] = { ...candidate, title, status: 'created', selected: false };
      } catch {
        nextRows[index] = { ...candidate, title, status: 'failed', selected: true };
      }
    }
    setRows(nextRows);
    const created = nextRows.filter((row) => row.status === 'created').length;
    const duplicates = nextRows.filter(
      (row) => row.status === 'duplicate-existing' || row.status === 'duplicate-batch'
    ).length;
    const failed = nextRows.filter((row) => row.status === 'failed').length;
    setSummary(copy.result(created, duplicates, failed));
    setImporting(false);
  };

  return (
    <section className="space-y-4 text-white">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-semibold">{copy.title}</h2>
        <button type="button" onClick={onClose} className="rounded-full bg-white/10 px-4 py-2">
          {copy.close}
        </button>
      </div>
      <p className="text-sm text-white/60">{copy.method}</p>
      <label className="block text-sm font-medium">
        {copy.source}
        <textarea
          aria-label={copy.source}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          className="mt-2 min-h-36 w-full rounded-2xl border border-white/15 bg-black/20 p-3"
        />
      </label>
      <button
        type="button"
        onClick={() => void classify()}
        disabled={loading || importing}
        className="rounded-full bg-amber-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
      >
        {loading ? copy.classifying : copy.classify}
      </button>
      {rows.length > 0 ? (
        <fieldset className="space-y-3" disabled={importing}>
          <legend className="text-lg font-semibold">{copy.review}</legend>
          {rows.map((row, index) => (
            <div
              key={row.id}
              data-testid={`bulk-row-${index}`}
              className="grid gap-2 rounded-2xl border border-white/10 p-3 sm:grid-cols-[auto_1fr_12rem]"
            >
              <input
                type="checkbox"
                checked={row.selected}
                onChange={(event) => updateRow(row.id, { selected: event.target.checked })}
              />
              <input
                aria-label={copy.taskTitle}
                value={row.title}
                onChange={(event) => updateRow(row.id, { title: event.target.value })}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2"
              />
              <select
                aria-label={copy.quadrant}
                value={row.quadrant}
                onChange={(event) => updateRow(row.id, { quadrant: Number(event.target.value) })}
                className="rounded-xl border border-white/15 bg-slate-950 px-3 py-2"
              >
                <option value={0}>{t('matrix.do')}</option>
                <option value={1}>{t('matrix.delegate')}</option>
                <option value={2}>{t('matrix.schedule')}</option>
                <option value={3}>{t('matrix.delete')}</option>
              </select>
              {row.status === 'duplicate-existing' ? (
                <p className="col-span-full text-sm text-amber-200">{copy.existing}</p>
              ) : null}
              {row.status === 'duplicate-batch' ? (
                <p className="col-span-full text-sm text-amber-200">{copy.repeated}</p>
              ) : null}
              {row.status === 'failed' ? (
                <p className="col-span-full text-sm text-red-200">{copy.failed}</p>
              ) : null}
              {row.status === 'created' ? (
                <p className="col-span-full text-sm text-emerald-200">{copy.created}</p>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void persist(false)}
              className="rounded-full bg-emerald-400 px-4 py-2 font-semibold text-slate-950"
            >
              {copy.confirm}
            </button>
            {rows.some((row) => row.status === 'failed') ? (
              <button
                type="button"
                onClick={() => void persist(true)}
                className="rounded-full border border-white/15 px-4 py-2 font-semibold"
              >
                {copy.retry}
              </button>
            ) : null}
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {summary ? (
        <p role="status" className="text-sm text-emerald-200">
          {summary}
        </p>
      ) : null}
    </section>
  );
}
