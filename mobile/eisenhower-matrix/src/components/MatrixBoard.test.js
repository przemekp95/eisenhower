import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import MatrixBoard from './MatrixBoard';
import { translations } from '../i18n/translations';
import { getQuadrantOptions } from '../utils/aiUi';

describe('MatrixBoard destructive actions', () => {
  it('distinguishes the Delete quadrant from permanent deletion and asks for confirmation', () => {
    const t = translations.pl;
    const onDelete = jest.fn();
    const groupedTasks = {
      0: [], 1: [], 2: [],
      3: [{ id: 'task-3', title: 'Maybe later', urgent: false, important: false }],
    };
    const { getByTestId, getByText } = render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={onDelete}
        onToggle={jest.fn()}
        onResolveConflict={jest.fn()}
        t={t}
      />
    );

    expect(getByText('Usuń (kwadrant, nie kasowanie)')).toBeTruthy();
    fireEvent.press(getByTestId('delete-task-task-3'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(getByText('Trwale usunąć „Maybe later”?')).toBeTruthy();
    fireEvent.press(getByTestId('confirm-delete-task-3'));
    expect(onDelete).toHaveBeenCalledWith('task-3');
  });

  it('exposes pending conflict and transport states and lets deletion be cancelled', () => {
    const t = translations.pl;
    const onDelete = jest.fn();
    const groupedTasks = {
      0: [
        {
          id: 'conflict',
          title: 'Conflict',
          syncState: 'conflict',
          syncError: 'conflict',
          pendingIntent: { type: 'update' },
        },
        { id: 'error', title: 'Error', syncState: 'pending_create', syncError: 'error' },
      ],
      1: [], 2: [], 3: [],
    };
    const onResolveConflict = jest.fn();
    const { getByTestId, getByText, queryByText } = render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={onDelete}
        onToggle={jest.fn()}
        onResolveConflict={onResolveConflict}
        t={t}
      />
    );

    expect(getByText(t.syncConflict)).toBeTruthy();
    fireEvent.press(getByTestId('conflict-keep-remote-conflict'));
    fireEvent.press(getByTestId('conflict-retry-local-conflict'));
    expect(onResolveConflict).toHaveBeenCalledWith('conflict', 'remote');
    expect(onResolveConflict).toHaveBeenCalledWith('conflict', 'local');
    expect(getByText(t.syncError)).toBeTruthy();
    fireEvent.press(getByTestId('delete-task-conflict'));
    expect(queryByText('Trwale usunąć „Conflict”?')).toBeTruthy();
    fireEvent.press(getByTestId('cancel-delete-conflict'));
    expect(queryByText('Trwale usunąć „Conflict”?')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
