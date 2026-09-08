import { useRef, useState } from 'react';
import { OCRResult, extractTasksFromImage } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

export interface OCRImportSummary {
  imported: number;
  failed: number;
}

interface Props {
  onTasksExtracted: (
    result: OCRResult
  ) => Promise<OCRImportSummary | number | void> | OCRImportSummary | number | void;
}

type ReviewTask = OCRResult['classified_tasks'][number] & { selected: boolean };

export default function ImageUpload({ onTasksExtracted }: Props) {
  const [result, setResult] = useState<OCRResult | null>(null);
  const [reviewTasks, setReviewTasks] = useState<ReviewTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { language, t } = useLanguage();

  const copy =
    language === 'pl'
      ? {
          review: 'Sprawdź zadania przed importem',
          method:
            'Tekst odczytuje Tesseract, a kwadrant sugeruje klasyfikator MiniLM + PyTorch/MLP.',
          include: 'Uwzględnij zadanie',
          quadrant: 'Kwadrant dla',
          import: 'Importuj wybrane',
          importing: 'Importowanie…',
          none: 'Wybierz co najmniej jedno niepuste zadanie.',
          summary: (imported: number, failed: number) =>
            `Dodano: ${imported}. Nie dodano: ${failed}.`,
        }
      : {
          review: 'Review tasks before import',
          method:
            'Tesseract reads the text; the MiniLM + PyTorch/MLP classifier suggests quadrants.',
          include: 'Include task',
          quadrant: 'Quadrant for',
          import: 'Import selected',
          importing: 'Importing…',
          none: 'Select at least one non-empty task.',
          summary: (imported: number, failed: number) =>
            `Added: ${imported}. Not added: ${failed}.`,
        };

  const handleSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const payload = await extractTasksFromImage(file);
      setResult(payload);
      setReviewTasks(payload.classified_tasks.map((task) => ({ ...task, selected: true })));
    } catch {
      setError(t('ai.ocr.failed'));
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  };

  const updateReviewTask = (index: number, patch: Partial<ReviewTask>) => {
    setReviewTasks((current) =>
      current.map((task, taskIndex) => (taskIndex === index ? { ...task, ...patch } : task))
    );
  };

  const handleImport = async (reviewedSource: OCRResult) => {
    const selected = reviewTasks.filter((task) => task.selected && task.text.trim());
    if (selected.length === 0) {
      setError(copy.none);
      return;
    }

    setImporting(true);
    setError(null);
    setStatus(null);
    try {
      const reviewedResult: OCRResult = {
        ...reviewedSource,
        classified_tasks: selected.map(({ selected: _selected, ...task }) => ({
          ...task,
          text: task.text.trim(),
          quadrant: Number(task.quadrant),
        })),
      };
      const response = await onTasksExtracted(reviewedResult);
      const summary: OCRImportSummary =
        typeof response === 'number'
          ? { imported: response, failed: selected.length - response }
          : (response ?? { imported: 0, failed: selected.length });
      setStatus(copy.summary(summary.imported, summary.failed));
    } catch {
      setError(t('ai.ocr.failed'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="ocr-review-title">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        data-testid="image-upload-input"
        aria-label={t('ai.ocr.upload')}
        onChange={handleSelect}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="hidden"
        data-testid="image-camera-input"
        aria-label={t('ai.ocr.camera')}
        onChange={handleSelect}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading || importing}
          onClick={() => inputRef.current?.click()}
          className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-white/15 disabled:opacity-50"
        >
          {loading ? t('ai.ocr.extracting') : t('ai.ocr.gallery')}
        </button>
        <button
          type="button"
          disabled={loading || importing}
          onClick={() => cameraInputRef.current?.click()}
          className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? t('ai.ocr.extracting') : t('ai.ocr.camera')}
        </button>
      </div>
      <p className="max-w-2xl text-xs leading-5 text-white/55">{copy.method}</p>
      <p className="max-w-2xl text-xs leading-5 text-white/55">{t('ai.ocr.privacy')}</p>

      {result ? (
        <fieldset className="space-y-3" disabled={importing}>
          <legend id="ocr-review-title" className="font-semibold text-white">
            {copy.review}
          </legend>
          {reviewTasks.map((task, index) => (
            <div
              key={index}
              className="grid gap-2 rounded-2xl border border-white/10 p-3 sm:grid-cols-[auto_1fr_12rem]"
            >
              <input
                type="checkbox"
                checked={task.selected}
                aria-label={`${copy.include}: ${task.text}`}
                onChange={(event) => updateReviewTask(index, { selected: event.target.checked })}
              />
              <label className="sr-only" htmlFor={`ocr-task-${index}`}>
                {copy.include} {index + 1}
              </label>
              <input
                id={`ocr-task-${index}`}
                value={task.text}
                onChange={(event) => updateReviewTask(index, { text: event.target.value })}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-white"
              />
              <label className="sr-only" htmlFor={`ocr-quadrant-${index}`}>
                {copy.quadrant} {task.text}
              </label>
              <select
                id={`ocr-quadrant-${index}`}
                value={task.quadrant}
                onChange={(event) =>
                  updateReviewTask(index, { quadrant: Number(event.target.value) })
                }
                className="rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-white"
              >
                <option value={0}>0 — {t('matrix.do')}</option>
                <option value={1}>1 — {t('matrix.delegate')}</option>
                <option value={2}>2 — {t('matrix.schedule')}</option>
                <option value={3}>3 — {t('matrix.delete')}</option>
              </select>
            </div>
          ))}
          <button
            type="button"
            onClick={() => void handleImport(result)}
            className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {importing ? copy.importing : copy.import}
          </button>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" aria-live="polite" className="text-sm text-emerald-200">
          {status}
        </p>
      ) : null}
    </section>
  );
}
