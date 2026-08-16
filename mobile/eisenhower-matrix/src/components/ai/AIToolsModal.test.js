import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import AIToolsModal from './AIToolsModal';
import { translations } from '../../i18n/translations';
import { getQuadrantOptions } from '../../utils/aiUi';

function createProps(overrides = {}) {
  const t = translations.pl;

  return {
    visible: true,
    t,
    availableTabs: ['analysis', 'ocr', 'batch'],
    activeTab: 'analysis',
    onTabChange: jest.fn(),
    onClose: jest.fn(),
    quadrantOptions: getQuadrantOptions(t),
    analysisTask: 'Przygotować roadmapę',
    onChangeAnalysisTask: jest.fn(),
    onRunAdvancedAnalysis: jest.fn(),
    analysisLoading: false,
    advancedAnalysis: {
      langchain_analysis: {
        reasoning: 'Pilne i ważne przez deadline.',
      },
    },
    suggestedQuadrant: 0,
    onAddAdvancedAnalysisToMatrix: jest.fn(),
    analysisAdding: false,
    onRunOcr: jest.fn(),
    ocrLoading: false,
    ocrResult: null,
    onChangeOcrItem: jest.fn(),
    onImportOcr: jest.fn(),
    batchInput: 'A\nB',
    onChangeBatchInput: jest.fn(),
    onRunBatchAnalyze: jest.fn(),
    batchLoading: false,
    batchResult: null,
    aiToolsError: '',
    aiToolsMessage: '',
    ...overrides,
  };
}

describe('AIToolsModal', () => {
  it('renders advanced analysis and both close buttons', () => {
    const props = createProps();
    const { getByTestId, getByText } = render(<AIToolsModal {...props} />);

    fireEvent.changeText(getByTestId('ai-analysis-input'), 'Nowe zadanie');
    fireEvent.press(getByTestId('ai-analysis-run-button'));
    fireEvent.press(getByTestId('ai-analysis-add-button'));
    fireEvent.press(getByTestId('ai-tools-close-top-button'));
    fireEvent.press(getByTestId('ai-tools-close-button'));

    expect(getByText('Pilne i ważne przez deadline.')).toBeTruthy();
    expect(getByTestId('ai-analysis-suggested').props.children).toContain('Zrób teraz');
    expect(props.onChangeAnalysisTask).toHaveBeenCalledWith('Nowe zadanie');
    expect(props.onRunAdvancedAnalysis).toHaveBeenCalled();
    expect(props.onAddAdvancedAnalysisToMatrix).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('renders OCR and batch tabs with their results', () => {
    const ocrProps = createProps({
      activeTab: 'ocr',
      ocrLoading: false,
      ocrResult: {
        items: [
          { id: '1', title: 'Task one', selected: true, quadrant: 0 },
          { id: '2', title: 'Task two', selected: false, quadrant: 3 },
        ],
      },
    });
    const { getByTestId, getByText, rerender } = render(<AIToolsModal {...ocrProps} />);

    fireEvent.press(getByTestId('ai-ocr-run-button'));
    fireEvent.changeText(getByTestId('ocr-title-1'), 'Reviewed task');
    fireEvent.press(getByTestId('ocr-quadrant-1-2'));
    fireEvent.press(getByTestId('ocr-import-button'));
    expect(getByTestId('ocr-title-1').props.value).toBe('Task one');
    expect(getByText('Przejrzyj pozycje przed importem')).toBeTruthy();
    expect(ocrProps.onRunOcr).toHaveBeenCalled();
    expect(ocrProps.onChangeOcrItem).toHaveBeenCalledWith('1', { title: 'Reviewed task' });
    expect(ocrProps.onChangeOcrItem).toHaveBeenCalledWith('1', { quadrant: 2 });
    expect(ocrProps.onImportOcr).toHaveBeenCalled();

    const batchProps = createProps({
      activeTab: 'batch',
      batchLoading: false,
      batchResult: {
        batch_results: [
          { task: 'Task A', analyses: { rag: { quadrant: 0 } } },
          { task: 'Task B', analyses: { rag: { quadrant: 3 } } },
        ],
      },
    });

    rerender(<AIToolsModal {...batchProps} />);
    fireEvent.changeText(getByTestId('ai-batch-input'), 'Task A\nTask B');
    fireEvent.press(getByTestId('ai-batch-run-button'));

    expect(getByText('Task A')).toBeTruthy();
    expect(getByText('Zrób teraz')).toBeTruthy();
    expect(getByText('Usuń (kwadrant, nie kasowanie)')).toBeTruthy();
    expect(batchProps.onChangeBatchInput).toHaveBeenCalledWith('Task A\nTask B');
    expect(batchProps.onRunBatchAnalyze).toHaveBeenCalled();
  });

  it('does not render unavailable tools or technical administration', () => {
    const props = createProps({ availableTabs: [], activeTab: 'analysis' });
    const { getByTestId, queryByTestId, queryByText } = render(<AIToolsModal {...props} />);

    expect(getByTestId('ai-tools-unavailable')).toBeTruthy();
    expect(queryByTestId('ai-analysis-run-button')).toBeNull();
    expect(queryByText(/provider|model|trening|administrator/i)).toBeNull();
  });

});
