import React from 'react';
import { render } from '@testing-library/react-native';
import AIStatusPanel from './AIStatusPanel';
import { translations } from '../i18n/translations';

describe('AIStatusPanel', () => {
  const t = translations.pl;

  it('renders connected provider statuses', () => {
    const { getByText } = render(
      <AIStatusPanel
        aiLoading={false}
        aiConnected
        providerControls={{
          local_model: { enabled: true, active: true },
          tesseract: { enabled: false, active: false },
        }}
        t={t}
      />
    );

    expect(getByText('Połączono z centralnym runtime AI')).toBeTruthy();
    expect(getByText('Model lokalny')).toBeTruthy();
    expect(getByText('Aktywny')).toBeTruthy();
    expect(getByText('Wyłączony')).toBeTruthy();
  });

  it('renders loading and unavailable states', () => {
    const { getAllByText, getByText } = render(
      <AIStatusPanel
        aiLoading
        aiConnected={false}
        providerControls={{}}
        t={t}
      />
    );

    expect(getByText('Ładowanie...')).toBeTruthy();
    expect(getAllByText('Niedostępny').length).toBeGreaterThan(0);
  });

  it('renders the offline message when the runtime is disconnected after loading', () => {
    const { getByText } = render(
      <AIStatusPanel
        aiLoading={false}
        aiConnected={false}
        providerControls={{}}
        t={t}
      />
    );

    expect(getByText('Centralny runtime AI jest niedostępny')).toBeTruthy();
  });
});
