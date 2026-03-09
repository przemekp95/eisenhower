import {
  applyAdvancedAnalysisResult,
  restoreReadyState,
  runAdvancedTaskAnalysis,
  replaceTaskById,
} from './uiState';

describe('uiState helpers', () => {
  it('replaces only the matching task id', () => {
    const tasks = [
      { _id: '1', title: 'First', description: '', urgent: false, important: false },
      { _id: '2', title: 'Second', description: '', urgent: true, important: false },
    ];
    const updated = { _id: '2', title: 'Updated', description: '', urgent: true, important: true };

    expect(replaceTaskById(tasks, '2', updated)).toEqual([
      tasks[0],
      updated,
    ]);
  });

  it('returns the original tasks when no id matches', () => {
    const tasks = [{ _id: '1', title: 'First', description: '', urgent: false, important: false }];
    const updated = { _id: '2', title: 'Updated', description: '', urgent: true, important: true };

    expect(replaceTaskById(tasks, '2', updated)).toEqual(tasks);
  });

  it('restores ready state only when the component is still mounted', () => {
    const onReady = jest.fn();

    restoreReadyState(false, onReady);
    restoreReadyState(true, onReady);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('skips empty advanced-analysis titles and forwards trimmed ones', async () => {
    const analyze = jest.fn().mockResolvedValue({
      task: 'roadmap',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Critical',
        confidence: 0.9,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 0,
        quadrant_name: 'Do Now',
        confidence: 0.8,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    await expect(runAdvancedTaskAnalysis('   ', 'pl', analyze)).resolves.toBeNull();
    await expect(runAdvancedTaskAnalysis('  roadmap  ', 'pl', analyze)).resolves.toMatchObject({
      task: 'roadmap',
    });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith('roadmap', 'pl');
  });

  it('only applies completed advanced-analysis results', () => {
    const onResult = jest.fn();
    const analysis = {
      task: 'roadmap',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Critical',
        confidence: 0.9,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 0,
        quadrant_name: 'Do Now',
        confidence: 0.8,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    };

    applyAdvancedAnalysisResult(null, onResult);
    applyAdvancedAnalysisResult(analysis, onResult);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(analysis);
  });
});
