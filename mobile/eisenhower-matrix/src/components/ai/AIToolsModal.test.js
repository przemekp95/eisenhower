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
    onChangeOcrItem: jest.fn(),
    onImportOcr: jest.fn(),
    ocrLearningConsent: false,
    onChangeOcrLearningConsent: jest.fn(),
    adminAuthenticated: true,
    adminTokenInput: '',
    onChangeAdminTokenInput: jest.fn(),
    onSubmitAdminToken: jest.fn(),
    onClearAdminToken: jest.fn(),
    clearConfirmationOpen: false,
    onRequestClear: jest.fn(),
    onCancelClear: jest.fn(),
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
      providerControls: {
        local_model: { enabled: true, active: true },
        tesseract: { enabled: true, active: true },
      },
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
    fireEvent(getByTestId('ocr-learning-consent'), 'valueChange', true);
    fireEvent.press(getByTestId('ocr-import-button'));
    expect(getByTestId('ocr-title-1').props.value).toBe('Task one');
    expect(getByText('Przejrzyj pozycje przed importem')).toBeTruthy();
    expect(ocrProps.onRunOcr).toHaveBeenCalled();
    expect(ocrProps.onChangeOcrItem).toHaveBeenCalledWith('1', { title: 'Reviewed task' });
    expect(ocrProps.onChangeOcrItem).toHaveBeenCalledWith('1', { quadrant: 2 });
    expect(ocrProps.onChangeOcrLearningConsent).toHaveBeenCalledWith(true);
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

  it('gates unavailable AI actions inside the modal with accessible guidance', () => {
    const unavailable = {
      local_model: { enabled: true, available: false, active: false },
      tesseract: { enabled: true, available: false, active: false },
    };
    const props = createProps({ providerControls: unavailable, advancedAnalysis: null });
    const { getByTestId, getByText, rerender } = render(<AIToolsModal {...props} />);

    expect(getByTestId('ai-analysis-run-button').props.accessibilityState.disabled).toBe(true);
    expect(getByText('AI jest teraz niedostępne. Nadal możesz ręcznie wybrać kwadrant i dodać zadanie.')).toBeTruthy();
    fireEvent.press(getByTestId('ai-analysis-run-button'));
    expect(props.onRunAdvancedAnalysis).not.toHaveBeenCalled();

    rerender(<AIToolsModal {...createProps({ activeTab: 'ocr', providerControls: unavailable })} />);
    expect(getByTestId('ai-ocr-run-button').props.accessibilityState.disabled).toBe(true);

    rerender(<AIToolsModal {...createProps({ activeTab: 'batch', providerControls: unavailable })} />);
    expect(getByTestId('ai-batch-run-button').props.accessibilityState.disabled).toBe(true);
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
    expect(props.onRequestClear).toHaveBeenCalled();
    expect(props.onSelectExamplesQuadrant).toHaveBeenCalledWith(3);
    expect(props.onLoadExamples).toHaveBeenCalled();
  });

  it('requires a separate admin credential only inside management', () => {
    const props = createProps({
      activeTab: 'manage',
      adminAuthenticated: false,
      adminTokenInput: 'admin-secret',
    });
    const { getByTestId, queryByTestId } = render(<AIToolsModal {...props} />);

    expect(queryByTestId('manage-add-example-button')).toBeNull();
    fireEvent.changeText(getByTestId('manage-admin-token-input'), 'changed-admin-secret');
    fireEvent.press(getByTestId('manage-admin-submit-button'));

    expect(props.onChangeAdminTokenInput).toHaveBeenCalledWith('changed-admin-secret');
    expect(props.onSubmitAdminToken).toHaveBeenCalled();
  });

  it('confirms clearing training data before invoking the destructive action', () => {
    const props = createProps({ activeTab: 'manage' });
    const { getByTestId, rerender } = render(<AIToolsModal {...props} />);

    fireEvent.press(getByTestId('manage-clear-button'));
    expect(props.onRequestClear).toHaveBeenCalled();
    expect(props.onClear).not.toHaveBeenCalled();

    const confirmingProps = createProps({ activeTab: 'manage', clearConfirmationOpen: true });
    rerender(<AIToolsModal {...confirmingProps} />);
    fireEvent.press(getByTestId('manage-clear-confirm-button'));
    expect(confirmingProps.onClear).toHaveBeenCalled();
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
