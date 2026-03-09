import { useRef, useState } from 'react';
import { OCRResult, extractTasksFromImage } from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

interface Props {
  onTasksExtracted: (result: OCRResult) => Promise<void> | void;
}

export default function ImageUpload({ onTasksExtracted }: Props) {
  const [result, setResult] = useState<OCRResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { language, t } = useLanguage();

  const format = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (current, [key, value]) => current.replace(`{${key}}`, String(value)),
      template
    );

  const formatOcrResult = (count: number, filename: string) => {
    if (language === 'pl') {
      const remainder10 = count % 10;
      const remainder100 = count % 100;

      if (count === 1) {
        return format(t('ai.ocr.result.one'), { filename });
      }

      if (remainder10 >= 2 && remainder10 <= 4 && !(remainder100 >= 12 && remainder100 <= 14)) {
        return format(t('ai.ocr.result.few'), { count, filename });
      }

      return format(t('ai.ocr.result.other'), { count, filename });
    }

    return count === 1
      ? format(t('ai.ocr.result.one'), { filename })
      : format(t('ai.ocr.result.other'), { count, filename });
  };

  const handleSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = await extractTasksFromImage(file);
      setResult(payload);
      await onTasksExtracted(payload);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('ai.ocr.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.txt"
        className="hidden"
        data-testid="image-upload-input"
        onChange={handleSelect}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-white/15 hover:text-white"
      >
        {loading ? t('ai.ocr.extracting') : t('ai.ocr.upload')}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {result ? (
        <p className="text-sm text-white">
          {formatOcrResult(result.summary.total_tasks, result.filename)}
        </p>
      ) : null}
    </section>
  );
}
