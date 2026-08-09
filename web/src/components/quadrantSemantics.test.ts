import { QUADRANT_LABEL_KEYS, quadrantToTaskState } from './matrixUtils';

describe('Eisenhower quadrant semantics', () => {
  it.each([
    [0, { urgent: true, important: true }, 'matrix.do'],
    [1, { urgent: true, important: false }, 'matrix.delegate'],
    [2, { urgent: false, important: true }, 'matrix.schedule'],
    [3, { urgent: false, important: false }, 'matrix.delete'],
  ] as const)('keeps quadrant %i flags and label aligned', (quadrant, flags, labelKey) => {
    expect(quadrantToTaskState(quadrant)).toEqual(flags);
    expect(QUADRANT_LABEL_KEYS[quadrant]).toBe(labelKey);
  });
});
