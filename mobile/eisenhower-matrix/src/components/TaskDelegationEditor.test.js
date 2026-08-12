import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import TaskDelegationEditor from './TaskDelegationEditor';
import { translations } from '../i18n/translations';

describe('TaskDelegationEditor', () => {
  it('lets an owner assign, reassign and cancel delegation accessibly', () => {
    const onAssign = jest.fn();
    const onCancel = jest.fn();
    const view = render(<TaskDelegationEditor
      taskId="task-1"
      delegation={null}
      role="owner"
      onAssign={onAssign}
      onCancel={onCancel}
      t={translations.pl}
    />);
    fireEvent.press(view.getByTestId('delegation-edit-task-1'));
    fireEvent.changeText(view.getByTestId('delegation-user-task-1'), 'user-b');
    fireEvent.changeText(view.getByTestId('delegation-label-task-1'), 'Pat');
    fireEvent.changeText(view.getByTestId('delegation-note-task-1'), 'Użyj runbooka');
    fireEvent.press(view.getByTestId('delegation-save-task-1'));
    expect(onAssign).toHaveBeenCalledWith('task-1', {
      assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'Użyj runbooka',
    });

    view.rerender(<TaskDelegationEditor
      taskId="task-1"
      delegation={{ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered' }}
      role="owner"
      onAssign={onAssign}
      onCancel={onCancel}
      t={translations.pl}
    />);
    fireEvent.press(view.getByTestId('delegation-cancel-task-1'));
    expect(onCancel).toHaveBeenCalledWith('task-1');
  });

  it('shows delegated work and only valid assignee status actions', () => {
    const onStatus = jest.fn();
    const view = render(<TaskDelegationEditor
      taskId="task-2"
      delegation={{ assigneeUserId: 'me', displayLabel: 'Ja', handoffNote: 'Sprawdź checklistę', status: 'offered' }}
      role="assignee"
      onStatus={onStatus}
      t={translations.en}
    />);
    expect(view.getByText('Sprawdź checklistę')).toBeTruthy();
    fireEvent.press(view.getByTestId('delegation-status-accepted-task-2'));
    expect(onStatus).toHaveBeenCalledWith('task-2', 'accepted');
    expect(view.queryByTestId('delegation-status-completed-task-2')).toBeNull();
  });

  it('keeps invalid owner input open and supports cancelling the editor', () => {
    const onAssign = jest.fn();
    const view = render(<TaskDelegationEditor taskId="task-3" delegation={null} role="owner"
      onAssign={onAssign} onCancel={jest.fn()} t={translations.en} />);
    fireEvent.press(view.getByTestId('delegation-edit-task-3'));
    fireEvent.press(view.getByTestId('delegation-save-task-3'));
    expect(view.getByRole('alert')).toBeTruthy();
    expect(onAssign).not.toHaveBeenCalled();
    fireEvent.press(view.getByText('Cancel'));
    expect(view.queryByTestId('delegation-user-task-3')).toBeNull();
  });

  it('renders safe assignee fallbacks when delegation metadata is incomplete', () => {
    const view = render(<TaskDelegationEditor taskId="task-4" delegation={null} role="assignee"
      onStatus={jest.fn()} t={translations.en} />);
    expect(view.getByText('Assignee label: Unknown')).toBeTruthy();
  });

  it('defaults a missing owner status label to offered', () => {
    const view = render(<TaskDelegationEditor taskId="task-5"
      delegation={{ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' }} role="owner"
      onAssign={jest.fn()} onCancel={jest.fn()} t={translations.en} />);
    expect(view.getByText('Assigned to: Pat · Offered')).toBeTruthy();
  });
});
