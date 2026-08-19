import { act, renderHook } from '@testing-library/react';
import { useMatrixController } from './useMatrixController';
import type { OCRResult } from '../services/api';

const result: OCRResult = {
  filename: 'tasks.png',
  image_info: { size_bytes: 10, shape: 'unknown' },
  ocr: { extracted_text: 'Escalate\nPlan', raw_tasks_detected: 4, method: 'tesseract' },
  classified_tasks: [
    { text: '  Escalate  ', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
    { text: '', quadrant: 1, quadrant_name: 'Delegate', confidence: 0.1 },
    { text: 'Plan', quadrant: 2, quadrant_name: 'Schedule', confidence: 0.8 },
    { text: 'Escalate', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.7 },
  ],
  summary: {
    total_tasks: 4,
    quadrant_distribution: {
      counts: { 0: 2, 1: 0, 2: 1, 3: 0 },
      percentages: { 0: 66, 1: 0, 2: 34, 3: 0 },
      quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
    },
  },
  timestamp: '2026-08-19T00:00:00.000Z',
};

it('deduplicates OCR rows and retries failures with the same per-item idempotency key', async () => {
  const onAddTask = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const { result: hook } = renderHook(() =>
    useMatrixController({
      tasks: [],
      onAddTask,
      onUpdateTask: jest.fn(),
      translate: (key) => key,
    })
  );

  let first!: { imported: number; failed: number };
  await act(async () => {
    first = await hook.current.handleOCRImport(result);
  });
  expect(first).toEqual({ imported: 1, failed: 1 });
  expect(onAddTask).toHaveBeenCalledTimes(2);
  expect(onAddTask.mock.calls[0][0]).toEqual({
    title: 'Escalate',
    description: '',
    urgent: true,
    important: true,
  });
  expect(onAddTask.mock.calls[1][0]).toEqual({
    title: 'Plan',
    description: '',
    urgent: false,
    important: true,
  });
  const failedKey = onAddTask.mock.calls[0][1];

  let retried!: { imported: number; failed: number };
  await act(async () => {
    retried = await hook.current.handleOCRImport(result);
  });
  expect(retried).toEqual({ imported: 2, failed: 0 });
  expect(onAddTask.mock.calls[2][1]).toBe(failedKey);
});
