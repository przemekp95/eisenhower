import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MemoryControls from './MemoryControls';
import { LanguageProvider } from '../../i18n/LanguageContext';
import * as api from '../../services/api';

jest.mock('../../services/api');
const mockedApi = jest.mocked(api);

const receipt: api.MemoryConsentReceipt = {
  confirmation_id: `h1:runtime:${'a'.repeat(64)}`,
  actor_user_id: 'owner-user',
  action: 'create',
  intent_checksum: 'b'.repeat(64),
  policy_version: 'eisenhower-memory-consent-v1',
  confirmed_at: '2026-08-17T00:00:00Z',
  expires_at: '2026-08-17T00:05:00Z',
};

function renderControls() {
  return render(
    <LanguageProvider>
      <MemoryControls />
    </LanguageProvider>
  );
}

describe('MemoryControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('eisenhower-language', 'en');
    mockedApi.prepareMemory.mockImplementation(async (intent) => ({
      action: intent.action,
      memory_id: intent.memory_id,
      receipt: { ...receipt, action: intent.action },
    }));
    mockedApi.confirmMemory.mockResolvedValue({
      memory_id: 'preference-1',
      status: 'active',
      projection_state: 'synchronized',
    });
    mockedApi.exportMemory.mockResolvedValue({ items: [] });
  });

  it('prepares a bounded preference and writes only after separate confirmation', async () => {
    renderControls();
    const preference = screen.getByLabelText('Communication preference');
    expect(preference).toHaveAttribute('maxLength', '2000');
    fireEvent.change(preference, {
      target: { value: 'Prefer concise Polish responses' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));

    await screen.findByRole('heading', { name: 'Review before saving' });
    expect(mockedApi.confirmMemory).not.toHaveBeenCalled();
    expect(screen.getAllByText('Prefer concise Polish responses')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm memory creation' }));

    await waitFor(() => expect(mockedApi.confirmMemory).toHaveBeenCalledTimes(1));
    expect(mockedApi.confirmMemory.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        action: 'create',
        memory_type: 'communication_preference',
        retention_class: 'user_controlled',
      })
    );
    expect(mockedApi.confirmMemory.mock.calls[0][2]).toMatch(/^memory-create-/);
  });

  it('keeps the prepared receipt available after a recoverable confirmation failure', async () => {
    mockedApi.confirmMemory.mockRejectedValueOnce(new Error('private upstream detail'));
    renderControls();
    fireEvent.change(screen.getByLabelText('Communication preference'), {
      target: { value: 'Use Polish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm memory creation' }));

    await screen.findByText('The memory was not saved. Your preview is still here. Try again.');
    expect(screen.getByRole('button', { name: 'Confirm memory creation' })).toBeEnabled();
    expect(screen.queryByText('private upstream detail')).not.toBeInTheDocument();
  });

  it('explains how to recover from an existing response-style preference conflict', async () => {
    mockedApi.confirmMemory.mockRejectedValueOnce(
      Object.assign(new Error('private conflict detail'), { status: 409 })
    );
    renderControls();
    fireEvent.change(screen.getByLabelText('Communication preference'), {
      target: { value: 'Use Polish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm memory creation' }));

    await screen.findByText(
      'A response-style preference already exists. Export your memories, revoke the active preference, then prepare this change again.'
    );
    expect(screen.getByRole('button', { name: 'Confirm memory creation' })).toBeEnabled();
    expect(screen.queryByText('private conflict detail')).not.toBeInTheDocument();
  });

  it('exports memories and requires fresh prepare plus confirm for revoke and delete', async () => {
    mockedApi.exportMemory.mockResolvedValue({
      items: [
        {
          memory_id: 'preference-1',
          memory_type: 'communication_preference',
          conflict_key: 'response-style',
          content: 'Prefer concise Polish responses',
          provenance: 'explicit web memory control',
          confidence: 1,
          salience: 0.8,
          retention_class: 'user_controlled',
          created_at: '2026-08-17T00:00:00Z',
          updated_at: '2026-08-17T00:00:00Z',
          expires_at: '2026-09-17T00:00:00Z',
          status: 'active',
          supersedes_id: null,
          superseded_by_id: null,
          consent_action: 'create',
          consent_policy_version: 'eisenhower-memory-consent-v1',
          consented_at: '2026-08-17T00:00:00Z',
        },
      ],
    });
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Export my memories' }));
    await screen.findByText('Prefer concise Polish responses');

    fireEvent.click(screen.getByRole('button', { name: 'Review consent revocation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm consent revocation' }));
    await waitFor(() =>
      expect(mockedApi.confirmMemory).toHaveBeenCalledWith(
        { action: 'revoke', memory_id: 'preference-1' },
        expect.objectContaining({ action: 'revoke' }),
        expect.stringMatching(/^memory-revoke-/)
      )
    );
    await screen.findByText('Consent was revoked after your confirmation.');
    mockedApi.confirmMemory.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Review permanent deletion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm permanent deletion' }));

    await waitFor(() =>
      expect(mockedApi.confirmMemory).toHaveBeenCalledWith(
        { action: 'delete', memory_id: 'preference-1' },
        expect.objectContaining({ action: 'delete' }),
        expect.stringMatching(/^memory-delete-/)
      )
    );
  });

  it('keeps validation and service failures recoverable without creating a memory', async () => {
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a preference before preparing the preview.'
    );

    mockedApi.prepareMemory.mockRejectedValueOnce(new Error('private prepare failure'));
    fireEvent.change(screen.getByLabelText('Communication preference'), {
      target: { value: 'Use short answers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The preview could not be prepared. Your text is still here. Try again.'
    );

    mockedApi.exportMemory.mockRejectedValueOnce(new Error('private export failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Export my memories' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your memories could not be exported. Try again.'
    );
    expect(mockedApi.confirmMemory).not.toHaveBeenCalled();
  });

  it('supports cancelling create and lifecycle previews and renders non-active states safely', async () => {
    mockedApi.exportMemory.mockResolvedValueOnce({
      items: [
        {
          memory_id: 'revoked-1',
          memory_type: 'communication_preference',
          conflict_key: 'response-style',
          content: 'Revoked preference',
          provenance: 'explicit web memory control',
          confidence: 1,
          salience: 0.8,
          retention_class: 'user_controlled',
          created_at: '2026-08-17T00:00:00Z',
          updated_at: '2026-08-17T00:00:00Z',
          expires_at: '2026-09-17T00:00:00Z',
          status: 'revoked',
          supersedes_id: null,
          superseded_by_id: null,
          consent_action: 'revoke',
          consent_policy_version: 'eisenhower-memory-consent-v1',
          consented_at: '2026-08-17T00:00:00Z',
        },
        {
          memory_id: 'deleted-1',
          memory_type: 'communication_preference',
          conflict_key: 'response-style',
          content: 'Deleted preference',
          provenance: 'explicit web memory control',
          confidence: 1,
          salience: 0.8,
          retention_class: 'user_controlled',
          created_at: '2026-08-17T00:00:00Z',
          updated_at: '2026-08-17T00:00:00Z',
          expires_at: '2026-09-17T00:00:00Z',
          status: 'deleted',
          supersedes_id: null,
          superseded_by_id: null,
          consent_action: 'delete',
          consent_policy_version: 'eisenhower-memory-consent-v1',
          consented_at: '2026-08-17T00:00:00Z',
        },
      ],
    });
    renderControls();

    fireEvent.change(screen.getByLabelText('Communication preference'), {
      target: { value: 'Use Polish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));
    await screen.findByRole('heading', { name: 'Review before saving' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Review before saving' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export my memories' }));
    await screen.findByText('Revoked preference');
    expect(screen.getByText('Deleted preference')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review consent revocation' })
    ).not.toBeInTheDocument();

    mockedApi.prepareMemory.mockRejectedValueOnce(new Error('private lifecycle failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Review permanent deletion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The preview could not be prepared. Your text is still here. Try again.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review permanent deletion' }));
    await screen.findByText('Permanently delete this memory?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Permanently delete this memory?')).not.toBeInTheDocument();
  });

  it('uses the safe ID fallback and does not expose content for a non-create preview', async () => {
    const randomUuid = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(undefined as never);
    mockedApi.prepareMemory.mockImplementationOnce(async (intent) => {
      const mutatedIntent = intent as api.MemoryIntentDto & { action: 'delete' };
      mutatedIntent.action = 'delete';
      return {
        action: 'delete',
        memory_id: intent.memory_id,
        receipt: { ...receipt, action: 'delete' },
      };
    });
    renderControls();
    fireEvent.change(screen.getByLabelText('Communication preference'), {
      target: { value: 'Never render this preview' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare memory preview' }));

    await screen.findByRole('heading', { name: 'Review before saving' });
    expect(screen.getAllByText('Never render this preview')).toHaveLength(1);
    randomUuid.mockRestore();
  });
});
