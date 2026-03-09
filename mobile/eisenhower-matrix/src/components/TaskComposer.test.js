import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import TaskComposer from './TaskComposer';
import { translations } from '../i18n/translations';

describe('TaskComposer', () => {
  const t = translations.pl;

  it('renders inputs and fires all task actions', () => {
    const onChangeTask = jest.fn();
    const onAddTask = jest.fn();
    const onSuggest = jest.fn();
    const onScan = jest.fn();
    const onOpenAITools = jest.fn();

    const { getByPlaceholderText, getByTestId } = render(
      <TaskComposer
        newTask={{ title: '', description: '', urgent: false, important: false }}
        onChangeTask={onChangeTask}
        onAddTask={onAddTask}
        onSuggest={onSuggest}
        onScan={onScan}
        onOpenAITools={onOpenAITools}
        suggestDisabled={false}
        scanDisabled={false}
        t={t}
      />
    );

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Projekt');
    fireEvent.changeText(getByPlaceholderText('Opis'), 'Opis');
    fireEvent(getByTestId('new-task-urgent-switch'), 'valueChange', true);
    fireEvent(getByTestId('new-task-important-switch'), 'valueChange', true);
    fireEvent.press(getByTestId('add-task-button'));
    fireEvent.press(getByTestId('suggest-task-button'));
    fireEvent.press(getByTestId('scan-task-button'));
    fireEvent.press(getByTestId('open-ai-tools-button'));

    expect(onChangeTask).toHaveBeenCalledWith('title', 'Projekt');
    expect(onChangeTask).toHaveBeenCalledWith('description', 'Opis');
    expect(onChangeTask).toHaveBeenCalledWith('urgent', true);
    expect(onChangeTask).toHaveBeenCalledWith('important', true);
    expect(onAddTask).toHaveBeenCalled();
    expect(onSuggest).toHaveBeenCalled();
    expect(onScan).toHaveBeenCalled();
    expect(onOpenAITools).toHaveBeenCalled();
  });

  it('keeps disabled buttons inactive', () => {
    const onSuggest = jest.fn();
    const onScan = jest.fn();
    const { getByTestId } = render(
      <TaskComposer
        newTask={{ title: '', description: '', urgent: false, important: false }}
        onChangeTask={jest.fn()}
        onAddTask={jest.fn()}
        onSuggest={onSuggest}
        onScan={onScan}
        onOpenAITools={jest.fn()}
        suggestDisabled
        scanDisabled
        t={t}
      />
    );

    fireEvent.press(getByTestId('suggest-task-button'));
    fireEvent.press(getByTestId('scan-task-button'));

    expect(onSuggest).not.toHaveBeenCalled();
    expect(onScan).not.toHaveBeenCalled();
  });
});
