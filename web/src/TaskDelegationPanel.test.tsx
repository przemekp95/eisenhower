import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaskDelegationPanel from './components/TaskDelegationPanel';
import { LanguageProvider } from './i18n/LanguageContext';

const task = {
  _id: '1',
  title: 'Prepare handoff',
  description: '',
  urgent: true,
  important: false,
  lifecycleState: 'active' as const,
  revision: 4,
};

describe('TaskDelegationPanel', () => {
  beforeEach(() => localStorage.setItem('eisenhower-language', 'pl'));

  it('lets an owner assign, reassign, and cancel a handoff with labelled fields', async () => {
    const onAssign = jest.fn().mockResolvedValue(undefined);
    const view = render(
      <LanguageProvider>
        <TaskDelegationPanel task={task} view="owned" onAssign={onAssign} onStatus={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Przekaż Prepare handoff' }));
    fireEvent.change(screen.getByLabelText('Identyfikator osoby'), { target: { value: 'user-b' } });
    fireEvent.change(screen.getByLabelText('Nazwa wyświetlana'), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Notatka przekazania'), {
      target: { value: 'Użyj checklisty.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij przekazanie' }));
    await waitFor(() =>
      expect(onAssign).toHaveBeenCalledWith('1', {
        assigneeUserId: 'user-b',
        displayLabel: 'Pat',
        handoffNote: 'Użyj checklisty.',
      })
    );

    view.rerender(
      <LanguageProvider>
        <TaskDelegationPanel
          task={{
            ...task,
            delegation: {
              assigneeUserId: 'user-b',
              displayLabel: 'Pat',
              handoffNote: 'Użyj checklisty.',
              status: 'offered',
              offeredAt: '2026-08-12T12:00:00.000Z',
              statusUpdatedAt: '2026-08-12T12:00:00.000Z',
            },
          }}
          view="owned"
          onAssign={onAssign}
          onStatus={jest.fn()}
        />
      </LanguageProvider>
    );
    expect(screen.getByText(/Pat/)).toBeInTheDocument();
    expect(screen.getByText(/Oferowane/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj przekazanie Prepare handoff' }));
    await waitFor(() => expect(onAssign).toHaveBeenLastCalledWith('1', null));
  });

  it('shows only valid assignee status transitions in the delegated view', async () => {
    const onStatus = jest.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider>
        <TaskDelegationPanel
          task={{
            ...task,
            delegation: {
              assigneeUserId: 'user-b',
              displayLabel: 'Pat',
              handoffNote: 'Użyj checklisty.',
              status: 'offered',
              offeredAt: '2026-08-12T12:00:00.000Z',
              statusUpdatedAt: '2026-08-12T12:00:00.000Z',
            },
          }}
          view="delegated"
          onAssign={jest.fn()}
          onStatus={onStatus}
        />
      </LanguageProvider>
    );

    expect(screen.getByRole('button', { name: 'Akceptuj Prepare handoff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Odrzuć Prepare handoff' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rozpocznij/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Przekaż/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Akceptuj Prepare handoff' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('1', 'accepted'));
  });

  it('surfaces rejected assignments and lets the owner cancel editing', async () => {
    const onAssign = jest.fn().mockRejectedValue(new Error('offline'));
    render(
      <LanguageProvider>
        <TaskDelegationPanel task={task} view="owned" onAssign={onAssign} onStatus={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Przekaż Prepare handoff' }));
    fireEvent.change(screen.getByLabelText('Identyfikator osoby'), { target: { value: 'user-b' } });
    fireEvent.change(screen.getByLabelText('Nazwa wyświetlana'), { target: { value: 'Pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij przekazanie' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nie udało się zapisać zmian.');
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.queryByRole('form', { name: 'Przekaż Prepare handoff' })).not.toBeInTheDocument();
  });

  it('surfaces rejected assignee status transitions', async () => {
    const onStatus = jest.fn().mockRejectedValue(new Error('offline'));
    render(
      <LanguageProvider>
        <TaskDelegationPanel
          task={{
            ...task,
            delegation: {
              assigneeUserId: 'user-b',
              displayLabel: 'Pat',
              handoffNote: 'Użyj checklisty.',
              status: 'offered',
              offeredAt: '2026-08-12T12:00:00.000Z',
              statusUpdatedAt: '2026-08-12T12:00:00.000Z',
            },
          }}
          view="delegated"
          onAssign={jest.fn()}
          onStatus={onStatus}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Akceptuj Prepare handoff' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nie udało się zapisać zmian.');
  });
});
