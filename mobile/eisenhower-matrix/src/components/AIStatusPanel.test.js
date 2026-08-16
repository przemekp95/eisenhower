import React from 'react';
import { render } from '@testing-library/react-native';
import AIStatusPanel from './AIStatusPanel';
import { translations } from '../i18n/translations';

describe('AIStatusPanel', () => {
  const t = translations.pl;

  it('renders business availability without provider or model details', async () => {
    const { getByText, queryByText } = await render(
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

    expect(getByText('Pomoc w porządkowaniu zadań jest dostępna')).toBeTruthy();
    expect(queryByText('Model lokalny')).toBeNull();
    expect(queryByText('Tesseract OCR')).toBeNull();
  });

  it('renders loading and unavailable states', async () => {
    const { getByText } = await render(
      <AIStatusPanel
        aiLoading
        aiConnected={false}
        providerControls={{}}
        t={t}
      />
    );

    expect(getByText('Ładowanie...')).toBeTruthy();
  });

  it('renders the offline message when the runtime is disconnected after loading', async () => {
    const { getByText } = await render(
      <AIStatusPanel
        aiLoading={false}
        aiConnected={false}
        providerControls={{}}
        t={t}
      />
    );

    expect(getByText('Pomoc w porządkowaniu zadań jest chwilowo niedostępna')).toBeTruthy();
  });
});
