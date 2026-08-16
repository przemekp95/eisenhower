import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearAdminToken, setAdminToken } from '../authSession';
import { LanguageProvider } from '../i18n/LanguageContext';
import AIAdministrationDialog from './AIAdministrationDialog';

jest.mock('./ai/AIManagement', () => ({
  __esModule: true,
  default: ({ onModelUpdated }: { onModelUpdated: () => void }) => (
    <div>
      Management controls
      <button type="button" onClick={onModelUpdated}>
        notify model update
      </button>
    </div>
  ),
}));

function renderDialog(onClose = jest.fn()) {
  return render(
    <LanguageProvider>
      <AIAdministrationDialog onClose={onClose} />
    </LanguageProvider>
  );
}

describe('AIAdministrationDialog', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    act(() => clearAdminToken());
  });

  afterEach(() => act(() => clearAdminToken()));

  it('keeps the separate administrator credential gate', () => {
    renderDialog();
    expect(screen.getByLabelText('Administrator code')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Open administration' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Administrator code'), {
      target: { value: 'admin-only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open administration' }));
    expect(screen.getByText('Management controls')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'notify model update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change administrator code' }));
    expect(screen.getByLabelText('Administrator code')).toBeInTheDocument();
  });

  it('shows a rejected-code explanation', () => {
    act(() => clearAdminToken('rejected'));
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent(/incorrect or has expired/i);
  });

  it('closes on Escape and restores the opener', () => {
    setAdminToken('admin');
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = jest.fn();
    const view = renderDialog(onClose);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('localizes the independent gate in Polish', () => {
    localStorage.setItem('eisenhower-language', 'pl');
    renderDialog();
    expect(screen.getByText('Dostęp administracyjny')).toBeInTheDocument();
    expect(screen.getByLabelText('Kod administratora')).toBeInTheDocument();
  });

  it('localizes rejected and authenticated administration states in Polish', () => {
    localStorage.setItem('eisenhower-language', 'pl');
    act(() => clearAdminToken('rejected'));
    const view = renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent(/kod administratora jest nieprawidłowy/i);
    view.unmount();
    setAdminToken('admin');
    renderDialog();
    expect(screen.getByRole('button', { name: 'Zmień kod administratora' })).toBeInTheDocument();
  });

  it('traps focus in both directions and tolerates an empty temporary focus list', () => {
    setAdminToken('admin');
    renderDialog();
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'notify model update' });
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    const dialog = screen.getByRole('dialog');
    jest.spyOn(dialog, 'querySelectorAll').mockReturnValueOnce([] as never);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.keyDown(window, { key: 'Enter' });
  });

  it('closes from the backdrop but not from inside', () => {
    const onClose = jest.fn();
    renderDialog(onClose);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
