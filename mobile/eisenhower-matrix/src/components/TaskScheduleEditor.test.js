import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import TaskScheduleEditor from './TaskScheduleEditor';
import { translations } from '../i18n/translations';

describe('TaskScheduleEditor', () => {
  it('exposes an accessible edit/save/clear flow', () => {
    const onSave = jest.fn();
    const onClear = jest.fn();
    const schedule = {
      dueAt: '2026-08-15T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
      remindAt: '2026-08-15T10:00:00.000Z',
    };
    const view = render(
      <TaskScheduleEditor taskId="task-1" schedule={schedule} onSave={onSave} onClear={onClear} t={translations.pl} />
    );

    expect(view.getByTestId('schedule-display-task-1')).toBeTruthy();
    fireEvent.press(view.getByTestId('schedule-edit-task-1'));
    fireEvent.changeText(view.getByTestId('schedule-due-task-1'), '2026-08-15T13:00:00.000Z');
    fireEvent.press(view.getByTestId('schedule-save-task-1'));
    expect(onSave).toHaveBeenCalledWith('task-1', {
      ...schedule,
      dueAt: '2026-08-15T13:00:00.000Z',
    });
    fireEvent.press(view.getByTestId('schedule-clear-task-1'));
    expect(onClear).toHaveBeenCalledWith('task-1');
  });

  it('keeps invalid input open and announces a validation error', () => {
    const view = render(
      <TaskScheduleEditor taskId="task-2" schedule={null} onSave={jest.fn()} onClear={jest.fn()} t={translations.en} />
    );
    fireEvent.press(view.getByTestId('schedule-edit-task-2'));
    fireEvent.changeText(view.getByTestId('schedule-due-task-2'), 'tomorrow');
    fireEvent.changeText(view.getByTestId('schedule-timezone-task-2'), 'Mars/Olympus');
    fireEvent.press(view.getByTestId('schedule-save-task-2'));
    expect(view.getByRole('alert')).toBeTruthy();
    fireEvent.press(view.getByText('Cancel'));
    expect(view.queryByTestId('schedule-due-task-2')).toBeNull();
  });
});
