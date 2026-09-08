import { fireEvent, render, screen } from '@testing-library/react';
import AccountSecurityPanel from './AccountSecurityPanel';
import { LanguageProvider } from '../i18n/LanguageContext';

it('shows a safe unavailable-password state and keeps logout explicit without an issuer', () => {
  localStorage.setItem('eisenhower-language', 'en');
  const onLogout = jest.fn();
  render(
    <LanguageProvider>
      <AccountSecurityPanel onLogout={onLogout} />
    </LanguageProvider>
  );

  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText(/managed by your administrator/i)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  expect(onLogout).toHaveBeenCalledTimes(1);
});
