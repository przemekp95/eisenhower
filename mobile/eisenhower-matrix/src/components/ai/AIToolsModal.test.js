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
    batchInput: 'A\nB',
    onChangeBatchInput: jest.fn(),
    onRunBatchAnalyze: jest.fn(),
    batchLoading: false,
    batchResult: null,
    manageLoading: false,
    trainingStats: {
      total_examples: 9,
      model_name: 'local-minilm-mlp',
      model_ready: true,
      model_encoder: 'encoder',
    },
    providerControls: {
      local_model: { enabled: true, active: true },
      tesseract: { enabled: false, active: false },
    },
    providerBusy: { local_model: false, tesseract: false },
    onToggleProvider: jest.fn(),
    exampleText: 'Przykład',
    onChangeExampleText: jest.fn(),
    exampleQuadrant: 2,
    onSelectExampleQuadrant: jest.fn(),
    onAddExample: jest.fn(),
    feedbackTask: 'Feedback',
    onChangeFeedbackTask: jest.fn(),
    predictedQuadrant: 1,
    onSelectPredictedQuadrant: jest.fn(),
    correctQuadrant: 0,
    onSelectCorrectQuadrant: jest.fn(),
    onLearnFeedback: jest.fn(),
    preserveExperience: true,
    onChangePreserveExperience: jest.fn(),
    keepDefaults: false,
    onChangeKeepDefaults: jest.fn(),
    onRetrain: jest.fn(),
    onClear: jest.fn(),
    examplesQuadrant: 0,
    onSelectExamplesQuadrant: jest.fn(),
    onLoadExamples: jest.fn(),
    examples: [],
    aiToolsError: '',
    aiToolsMessage: '',
    manageAction: '',
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
        count: 2,
        items: [
          { id: '1', title: 'Task one' },
          { id: '2', title: 'Task two' },
        ],
      },
    });
    const { getByTestId, getByText, rerender } = render(<AIToolsModal {...ocrProps} />);

    fireEvent.press(getByTestId('ai-ocr-run-button'));
    expect(getByText('Task one')).toBeTruthy();
    expect(getByText('OCR zaimportował 2 zadań')).toBeTruthy();
    expect(ocrProps.onRunOcr).toHaveBeenCalled();

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
    expect(getByText('Usuń')).toBeTruthy();
    expect(batchProps.onChangeBatchInput).toHaveBeenCalledWith('Task A\nTask B');
    expect(batchProps.onRunBatchAnalyze).toHaveBeenCalled();
  });

  it('renders manage tab states and all management actions', () => {
    const loadingProps = createProps({
      activeTab: 'manage',
      manageLoading: true,
      examples: [],
      aiToolsError: 'Błąd',
      aiToolsMessage: 'Zapisano',
    });
    const { getByTestId, getByText, rerender } = render(<AIToolsModal {...loadingProps} />);

    expect(getByText('Ładowanie...')).toBeTruthy();
    expect(getByTestId('ai-tools-error').props.children).toBe('Błąd');
    expect(getByTestId('ai-tools-message').props.children).toBe('Zapisano');

    const props = createProps({
      activeTab: 'manage',
      examples: [{ text: 'urgent task' }],
    });
    rerender(<AIToolsModal {...props} />);

    fireEvent(getByTestId('modal-provider-switch-local_model'), 'valueChange', false);
    fireEvent(getByTestId('modal-provider-switch-tesseract'), 'valueChange', true);
    fireEvent.changeText(getByTestId('manage-example-input'), 'Nowy przykład');
    fireEvent.press(getByTestId('manage-example-quadrant-1'));
    fireEvent.press(getByTestId('manage-add-example-button'));
    fireEvent.changeText(getByTestId('manage-feedback-input'), 'Korekta');
    fireEvent.press(getByTestId('manage-predicted-quadrant-2'));
    fireEvent.press(getByTestId('manage-correct-quadrant-0'));
    fireEvent.press(getByTestId('manage-feedback-button'));
    fireEvent(getByTestId('manage-preserve-experience-switch'), 'valueChange', false);
    fireEvent(getByTestId('manage-keep-defaults-switch'), 'valueChange', true);
    fireEvent.press(getByTestId('manage-retrain-button'));
    fireEvent.press(getByTestId('manage-clear-button'));
    fireEvent.press(getByTestId('manage-browse-quadrant-3'));
    fireEvent.press(getByTestId('manage-load-examples-button'));

    expect(getByText('urgent task')).toBeTruthy();
    expect(props.onToggleProvider).toHaveBeenCalledWith('local_model');
    expect(props.onToggleProvider).toHaveBeenCalledWith('tesseract');
    expect(props.onChangeExampleText).toHaveBeenCalledWith('Nowy przykład');
    expect(props.onSelectExampleQuadrant).toHaveBeenCalledWith(1);
    expect(props.onAddExample).toHaveBeenCalled();
    expect(props.onChangeFeedbackTask).toHaveBeenCalledWith('Korekta');
    expect(props.onSelectPredictedQuadrant).toHaveBeenCalledWith(2);
    expect(props.onSelectCorrectQuadrant).toHaveBeenCalledWith(0);
    expect(props.onLearnFeedback).toHaveBeenCalled();
    expect(props.onChangePreserveExperience).toHaveBeenCalledWith(false);
    expect(props.onChangeKeepDefaults).toHaveBeenCalledWith(true);
    expect(props.onRetrain).toHaveBeenCalled();
    expect(props.onClear).toHaveBeenCalled();
    expect(props.onSelectExamplesQuadrant).toHaveBeenCalledWith(3);
    expect(props.onLoadExamples).toHaveBeenCalled();
  });

  it('renders unavailable model state in the manage summary', () => {
    const props = createProps({
      activeTab: 'manage',
      trainingStats: {
        total_examples: 2,
        model_name: 'local-minilm-mlp',
        model_ready: false,
        model_encoder: null,
      },
    });

    const { getByText, queryByText } = render(<AIToolsModal {...props} />);

    expect(getByText(/Niedostępny/)).toBeTruthy();
    expect(queryByText('encoder')).toBeNull();
  });
});
