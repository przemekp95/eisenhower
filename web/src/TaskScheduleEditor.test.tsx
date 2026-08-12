import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaskScheduleEditor, { localInputToUtc } from './components/TaskScheduleEditor';
import { LanguageProvider } from './i18n/LanguageContext';

describe('TaskScheduleEditor', () => {
  beforeEach(() => localStorage.setItem('eisenhower-language', 'pl'));

  it('displays local time with an explicit timezone and saves UTC instants', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: '1',
            title: 'Prepare release',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'active',
            schedule: {
              dueAt: '2026-08-15T12:00:00.000Z',
              timeZone: 'Europe/Warsaw',
              remindAt: '2026-08-15T10:00:00.000Z',
            },
          }}
          onSave={onSave}
        />
      </LanguageProvider>
    );

    expect(screen.getAllByText(/Europe\/Warsaw/)).toHaveLength(2);
    expect(screen.getByText(/14:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edytuj termin Prepare release' }));
    fireEvent.change(screen.getByLabelText('Termin'), { target: { value: '2026-08-16T09:30' } });
    fireEvent.change(screen.getByLabelText('Przypomnienie'), {
      target: { value: '2026-08-16T08:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz termin' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('1', {
        dueAt: '2026-08-16T07:30:00.000Z',
        timeZone: 'Europe/Warsaw',
        remindAt: '2026-08-16T06:30:00.000Z',
      })
    );
  });

  it('clears an existing schedule and keeps focusable labelled controls', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: '1',
            title: 'Prepare release',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'completed',
            schedule: {
              dueAt: '2026-08-15T12:00:00.000Z',
              timeZone: 'Europe/Warsaw',
            },
          }}
          onSave={onSave}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Wyczyść termin Prepare release' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('1', null));
  });

  it('rejects malformed and nonexistent local times', () => {
    expect(() => localInputToUtc('not-a-date', 'Europe/Warsaw')).toThrow(
      'Invalid local date and time'
    );
    expect(() => localInputToUtc('2026-03-29T02:30', 'Europe/Warsaw')).toThrow(
      'Local time does not exist in this timezone'
    );
  });

  it('validates reminder order and timezone changes before saving', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: '1',
            title: 'Prepare release',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'active',
          }}
          onSave={onSave}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dodaj termin Prepare release' }));
    fireEvent.change(screen.getByLabelText('Termin'), { target: { value: '2026-08-16T09:30' } });
    fireEvent.change(screen.getByLabelText('Przypomnienie'), {
      target: { value: '2026-08-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz termin' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Przypomnienie nie może być późniejsze niż termin.'
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Strefa czasowa'), {
      target: { value: 'Mars/Olympus' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz termin' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Podaj poprawny czas lokalny i strefę IANA.'
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(
      screen.queryByRole('form', { name: 'Edytuj termin Prepare release' })
    ).not.toBeInTheDocument();
  });

  it('surfaces rejected schedule saves and clears', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('offline'));
    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: '1',
            title: 'Prepare release',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'active',
            schedule: {
              dueAt: '2026-08-15T12:00:00.000Z',
              timeZone: 'Europe/Warsaw',
            },
          }}
          onSave={onSave}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj termin Prepare release' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz termin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Podaj poprawny czas lokalny i strefę IANA.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wyczyść termin Prepare release' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nie udało się zapisać zmian.');
  });

  it('falls back to UTC when the runtime does not report a timezone', () => {
    const resolvedOptions = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({
        locale: 'en-US',
        calendar: 'gregory',
        numberingSystem: 'latn',
        timeZone: undefined as unknown as string,
      });

    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: 'utc',
            title: 'UTC fallback',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'active',
          }}
          onSave={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dodaj termin UTC fallback' }));
    expect(screen.getByLabelText('Strefa czasowa')).toHaveValue('UTC');
    resolvedOptions.mockRestore();
  });

  it('formats scheduled instants in English', () => {
    localStorage.setItem('eisenhower-language', 'en');
    render(
      <LanguageProvider>
        <TaskScheduleEditor
          task={{
            _id: 'english',
            title: 'English schedule',
            description: '',
            urgent: false,
            important: true,
            lifecycleState: 'active',
            schedule: {
              dueAt: '2026-08-15T12:00:00.000Z',
              timeZone: 'Europe/Warsaw',
            },
          }}
          onSave={jest.fn()}
        />
      </LanguageProvider>
    );

    expect(screen.getByText(/15 Aug 2026/)).toBeInTheDocument();
  });
});
