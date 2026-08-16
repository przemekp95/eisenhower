import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import MatrixBoard from './MatrixBoard';
import { translations } from '../i18n/translations';
import { getQuadrantOptions } from '../utils/aiUi';

describe('MatrixBoard lifecycle actions', () => {
  it('distinguishes the Delete quadrant from trash and final deletion', async () => {
    const t = translations.pl;
    const onDelete = jest.fn();
    const onLifecycle = jest.fn();
    const groupedTasks = {
      0: [], 1: [], 2: [],
      3: [{ id: 'task-3', title: 'Maybe later', urgent: false, important: false, lifecycleState: 'active' }],
    };
    const { getByTestId, getByText, queryByTestId } = await render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={onDelete}
        onLifecycle={onLifecycle}
        onToggle={jest.fn()}
        onResolveConflict={jest.fn()}
        t={t}
      />
    );

    expect(getByText('Usuń (kwadrant, nie kasowanie)')).toBeTruthy();
    expect(queryByTestId('delete-task-task-3')).toBeNull();
    await fireEvent.press(getByTestId('lifecycle-trash-task-3'));
    expect(onLifecycle).toHaveBeenCalledWith('task-3', 'trash');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('offers state-specific reversible actions and confirms purge only from trash', async () => {
    const t = translations.en;
    const onDelete = jest.fn();
    const onLifecycle = jest.fn();
    const groupedTasks = {
      0: [
        { id: 'active', title: 'Active', lifecycleState: 'active' },
        { id: 'completed', title: 'Completed', lifecycleState: 'completed' },
        { id: 'archived', title: 'Archived', lifecycleState: 'archived' },
        { id: 'trashed', title: 'Trashed', lifecycleState: 'trashed' },
      ],
      1: [], 2: [], 3: [],
    };
    const { getByTestId, getByText } = await render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={onDelete}
        onLifecycle={onLifecycle}
        onToggle={jest.fn()}
        onResolveConflict={jest.fn()}
        t={t}
      />
    );

    await fireEvent.press(getByTestId('lifecycle-complete-active'));
    await fireEvent.press(getByTestId('lifecycle-reopen-completed'));
    await fireEvent.press(getByTestId('lifecycle-archive-active'));
    await fireEvent.press(getByTestId('lifecycle-restore-archived'));
    await fireEvent.press(getByTestId('lifecycle-restore-trashed'));
    expect(onLifecycle.mock.calls).toEqual([
      ['active', 'complete'],
      ['completed', 'reopen'],
      ['active', 'archive'],
      ['archived', 'restore'],
      ['trashed', 'restore'],
    ]);

    await fireEvent.press(getByTestId('delete-task-trashed'));
    expect(getByText('Permanently delete “Trashed” from trash?')).toBeTruthy();
    await fireEvent.press(getByTestId('cancel-delete-trashed'));
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.press(getByTestId('delete-task-trashed'));
    await fireEvent.press(getByTestId('confirm-delete-trashed'));
    expect(onDelete).toHaveBeenCalledWith('trashed');
  });

  it('exposes pending conflict and transport states and disables conflicting actions', async () => {
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
    const { getByTestId, getByText } = await render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={onDelete}
        onLifecycle={jest.fn()}
        onToggle={jest.fn()}
        onResolveConflict={onResolveConflict}
        t={t}
      />
    );

    expect(getByText(t.syncConflict)).toBeTruthy();
    await fireEvent.press(getByTestId('conflict-keep-remote-conflict'));
    await fireEvent.press(getByTestId('conflict-retry-local-conflict'));
    expect(onResolveConflict).toHaveBeenCalledWith('conflict', 'remote');
    expect(onResolveConflict).toHaveBeenCalledWith('conflict', 'local');
    expect(getByText(t.syncError)).toBeTruthy();
    expect(getByTestId('lifecycle-trash-conflict').props.accessibilityState.disabled).toBe(true);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('announces denied and missed reminder states', async () => {
    const t = translations.en;
    const groupedTasks = {
      0: [
        { id: 'denied', title: 'Denied reminder', lifecycleState: 'active', reminderStatus: 'permission_denied' },
        { id: 'missed', title: 'Missed reminder', lifecycleState: 'active', reminderStatus: 'missed' },
      ],
      1: [], 2: [], 3: [],
    };
    const view = await render(
      <MatrixBoard
        quadrantOptions={getQuadrantOptions(t)}
        groupedTasks={groupedTasks}
        onDelete={jest.fn()}
        onLifecycle={jest.fn()}
        onToggle={jest.fn()}
        onResolveConflict={jest.fn()}
        t={t}
      />
    );

    expect(view.getByText(t.reminderPermissionDenied)).toBeTruthy();
    expect(view.getByText(t.reminderMissed)).toBeTruthy();
  });
});
