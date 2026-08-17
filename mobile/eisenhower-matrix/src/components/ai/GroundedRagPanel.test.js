import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import GroundedRagPanel from './GroundedRagPanel';
import { translations } from '../../i18n/translations';

const answered = {
  status: 'answered',
  answer: 'MongoDB jest źródłem prawdy.',
  citations: [{
    chunk_id: 'chunk-1',
    title: 'Architektura',
    excerpt: 'MongoDB pozostaje kanoniczne.',
  }],
};

describe('GroundedRagPanel', () => {
  it('renders grounded citations and applies an editable preview only after confirmation', async () => {
    const onChangeQuestion = jest.fn();
    const onPrepareDescription = jest.fn();
    const onChangeDescriptionPreview = jest.fn();
    const onApplyDescription = jest.fn();
    const view = await render(
      <GroundedRagPanel
        t={translations.pl}
        question="Co jest kanoniczne?"
        onChangeQuestion={onChangeQuestion}
        onRun={jest.fn()}
        onCancel={jest.fn()}
        loading={false}
        result={answered}
        descriptionPreview="Oryginalny opis\n\nMongoDB jest źródłem prawdy."
        onPrepareDescription={onPrepareDescription}
        onChangeDescriptionPreview={onChangeDescriptionPreview}
        onApplyDescription={onApplyDescription}
        onDiscardDescription={jest.fn()}
      />
    );

    await fireEvent.changeText(view.getByTestId('grounded-question-input'), 'Nowe pytanie');
    await fireEvent.press(view.getByTestId('grounded-prepare-description'));
    await fireEvent.changeText(view.getByTestId('grounded-description-preview'), 'Sprawdzony opis');
    await fireEvent.press(view.getByTestId('grounded-apply-description'));

    expect(view.getByText('MongoDB jest źródłem prawdy.')).toBeTruthy();
    expect(view.getByText('Architektura')).toBeTruthy();
    expect(view.getByText('MongoDB pozostaje kanoniczne.')).toBeTruthy();
    expect(onChangeQuestion).toHaveBeenCalledWith('Nowe pytanie');
    expect(onPrepareDescription).toHaveBeenCalledWith(answered.answer);
    expect(onChangeDescriptionPreview).toHaveBeenCalledWith('Sprawdzony opis');
    expect(onApplyDescription).toHaveBeenCalled();
  });

  it('shows a no-answer state without fabricated citations', async () => {
    const view = await render(
      <GroundedRagPanel
        t={translations.pl}
        question="Nieznane"
        onChangeQuestion={jest.fn()}
        onRun={jest.fn()}
        onCancel={jest.fn()}
        loading={false}
        result={{ status: 'insufficient_evidence', answer: null, citations: [] }}
        descriptionPreview={null}
        onPrepareDescription={jest.fn()}
        onChangeDescriptionPreview={jest.fn()}
        onApplyDescription={jest.fn()}
        onDiscardDescription={jest.fn()}
      />
    );

    expect(view.getByTestId('grounded-no-answer')).toBeTruthy();
    expect(view.queryByTestId('grounded-prepare-description')).toBeNull();
  });

  it('exposes cancellation while a request is running', async () => {
    const onCancel = jest.fn();
    const view = await render(
      <GroundedRagPanel
        t={translations.pl}
        question="Pytanie"
        onChangeQuestion={jest.fn()}
        onRun={jest.fn()}
        onCancel={onCancel}
        loading
        result={null}
        descriptionPreview={null}
        onPrepareDescription={jest.fn()}
        onChangeDescriptionPreview={jest.fn()}
        onApplyDescription={jest.fn()}
        onDiscardDescription={jest.fn()}
      />
    );

    await fireEvent.press(view.getByTestId('grounded-cancel-button'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('handles an answered response without citations and disables an empty preview', async () => {
    const onApplyDescription = jest.fn();
    const view = await render(
      <GroundedRagPanel
        t={translations.pl}
        question="Pytanie"
        onChangeQuestion={jest.fn()}
        onRun={jest.fn()}
        onCancel={jest.fn()}
        loading={false}
        result={{ status: 'answered', answer: 'Odpowiedź bez cytowań.' }}
        descriptionPreview="   "
        onPrepareDescription={jest.fn()}
        onChangeDescriptionPreview={jest.fn()}
        onApplyDescription={onApplyDescription}
        onDiscardDescription={jest.fn()}
      />
    );

    expect(view.getByText('Odpowiedź bez cytowań.')).toBeTruthy();
    expect(view.queryByText('Architektura')).toBeNull();
    expect(view.getByTestId('grounded-apply-description').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(view.getByTestId('grounded-apply-description'));
    expect(onApplyDescription).not.toHaveBeenCalled();
  });
});
