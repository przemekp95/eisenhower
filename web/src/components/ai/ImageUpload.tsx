import { useRef, useState } from 'react';
import { OCRResult, extractTasksFromImage } from '../../services/api';

interface Props {
  onTasksExtracted: (result: OCRResult) => void;
}

export default function ImageUpload({ onTasksExtracted }: Props) {
  const [result, setResult] = useState<OCRResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      onTasksExtracted(payload);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'OCR failed');
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
        className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white"
      >
        {loading ? 'Extracting tasks...' : 'Upload image'}
      </button>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
      {result ? (
        <p className="text-sm text-white">
          Extracted {result.summary.total_tasks} tasks from {result.filename}
        </p>
      ) : null}
    </section>
  );
}
