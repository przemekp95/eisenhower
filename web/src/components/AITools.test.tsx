import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AITools from './AITools';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

function renderTools(overrides: Partial<React.ComponentProps<typeof AITools>> = {}) {
  return render(
    <LanguageProvider>
      <AITools taskTitle="urgent roadmap" onClose={jest.fn()} {...overrides} />
    </LanguageProvider>
  );
}

async function waitForCapabilityCheck() {
  await waitFor(() =>
    expect(
      screen.queryByRole('status', {
        name: /checking task assistance availability|sprawdzam dostępność pomocy/i,
      })
    ).not.toBeInTheDocument()
  );
}

describe('AITools task assistant', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: true,
      retrieval_augmented_generation: true,
      langchain_analysis: false,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: { local_model: true, tesseract: true, ocr: true },
    } as api.AICapabilities);
    mockedApi.answerKnowledge.mockResolvedValue({
      status: 'answered',
      answer: 'Approved incident guidance.',
      claims: [{ statement: 'Approved incident guidance.', citation_ids: ['chunk-1'] }],
      citations: [
        {
          chunk_id: 'chunk-1',
          document_id: 'document-1',
          source_uri: 'eisenhower://repository/incident-policy',
          title: 'Incident policy',
          excerpt: 'Follow the approved incident process.',
          score: 0.9,
          content_version: 'v1',
        },
      ],
      retrieval: { hit_count: 1, top_score: 0.9, embedding_version: 'minilm-v1' },
      no_answer_reason: null,
    });
    mockedApi.classifyTask.mockResolvedValue({
      task: 'urgent roadmap',
      urgent: true,
      important: true,
      quadrant: 0,
      quadrant_name: 'Do Now',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
      method: 'local',
    } as api.ClassificationResult);
    mockedApi.batchAnalyzeTasks.mockResolvedValue({
      batch_results: [],
      summary: { methods: {}, total_tasks: 1 },
      timestamp: new Date().toISOString(),
    });
  });

  it('combines task context, priority and grounded answers in one tab', async () => {
    renderTools({ taskDescription: 'Current context' });
    await waitForCapabilityCheck();
    expect(screen.getByRole('dialog', { name: 'Task assistance' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'urgent roadmap' })).toBeInTheDocument();
    expect(screen.getByText('Current context')).toBeInTheDocument();
    expect(screen.getByText('Task priority')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await screen.findByText('Approved incident guidance.');
  });

  it('keeps scan, bulk import, and memory management outside task-scoped help', async () => {
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: true,
      retrieval_augmented_generation: true,
      ocr: true,
      batch_analysis: true,
      memory_write: true,
      memory_retrieval: true,
      memory_response: true,
    } as api.AICapabilities);

    renderTools();
    await waitForCapabilityCheck();

    expect(screen.queryByRole('tab', { name: 'Scan notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Bulk review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Memory controls' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'urgent roadmap' })).toBeVisible();
  });

  it('applies the default no-op priority callback safely', async () => {
    renderTools();
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: Do Now');
    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm quadrant change' }));
    await screen.findByText('Task quadrant updated.');
  });

  it('closes on Escape and backdrop, but not inside the dialog', () => {
    const onClose = jest.fn();
    renderTools({ onClose });
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('locks scroll, traps focus and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = renderTools();
    await waitForCapabilityCheck();
    const close = screen.getByRole('button', { name: 'Close' });
    const lastAction = screen.getByRole('button', { name: 'Check sources' });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(lastAction).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    opener.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(lastAction).toHaveFocus();
    close.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    opener.disabled = true;
    view.rerender(
      <LanguageProvider>
        <AITools taskTitle="urgent roadmap" onClose={jest.fn()} />
      </LanguageProvider>
    );
    opener.disabled = false;
    view.unmount();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });

  it('tolerates an opener removed before cleanup', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = renderTools();
    opener.remove();
    view.unmount();
  });

  it('handles an empty temporary focus list and non-navigation keys', () => {
    const onClose = jest.fn();
    renderTools({ onClose });
    const dialog = screen.getByRole('dialog');
    jest.spyOn(dialog, 'querySelectorAll').mockReturnValueOnce([] as never);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('compensates for a scrollbar gap and restores the padding', () => {
    const innerWidth = window.innerWidth;
    const clientWidth = document.documentElement.clientWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1180,
    });
    const view = renderTools();
    expect(document.body.style.paddingRight).toBe('20px');
    view.unmount();
    expect(document.body.style.paddingRight).toBe('');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    });
  });

  it('does not add body padding when there is no scrollbar gap', () => {
    const innerWidth = window.innerWidth;
    const clientWidth = document.documentElement.clientWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1200,
    });
    const view = renderTools();
    expect(document.body.style.paddingRight).toBe('');
    view.unmount();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    });
  });

  it('keeps manual task recovery available when every optional AI capability is offline', async () => {
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: false,
      reasoned_local_analysis: false,
      knowledge_retrieval: false,
      retrieval_augmented_generation: false,
      langchain_analysis: false,
      ocr: false,
      batch_analysis: false,
      training_management: false,
      providers: { local_model: false, tesseract: false, ocr: false },
    } as api.AICapabilities);
    const onClose = jest.fn();

    renderTools({ onClose });

    await screen.findByText(/Task assistance is currently unavailable/i);
    expect(screen.queryByRole('button', { name: 'Suggest quadrant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check sources' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /choose the quadrant manually/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['classification', true, false],
    ['knowledge', false, true],
  ])(
    'keeps the available %s part of the combined assistant usable',
    async (_name, classification, knowledge) => {
      mockedApi.getCapabilities.mockResolvedValueOnce({
        classification,
        reasoned_local_analysis: classification,
        knowledge_retrieval: knowledge,
        retrieval_augmented_generation: knowledge,
        langchain_analysis: false,
        ocr: false,
        batch_analysis: false,
        training_management: false,
        providers: { local_model: classification, tesseract: false, ocr: false },
      } as api.AICapabilities);

      renderTools();
      await waitForCapabilityCheck();

      expect(screen.queryByRole('button', { name: 'Suggest quadrant' }) !== null).toBe(
        classification
      );
      expect(screen.queryByRole('button', { name: 'Check sources' }) !== null).toBe(knowledge);
    }
  );

  it('gates every tool while capability availability is still being checked', async () => {
    let resolveCapabilities!: (capabilities: api.AICapabilities) => void;
    mockedApi.getCapabilities.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCapabilities = resolve;
        })
    );

    renderTools();

    expect(
      screen.getByRole('status', { name: /checking task assistance availability/i })
    ).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Suggest quadrant' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-upload-input')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review task list' })).not.toBeInTheDocument();

    await act(async () => resolveCapabilities(await mockedApi.getCapabilities()));
    await waitForCapabilityCheck();
  });

  it('retries an unavailable capability check without exposing provider details', async () => {
    mockedApi.getCapabilities
      .mockRejectedValueOnce(new Error('private provider details'))
      .mockResolvedValueOnce({
        classification: true,
        reasoned_local_analysis: true,
        knowledge_retrieval: true,
        retrieval_augmented_generation: true,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: true,
        training_management: true,
        providers: { local_model: true, tesseract: true, ocr: true },
      } as api.AICapabilities);

    renderTools();

    await screen.findByText(/Task assistance availability could not be checked/i);
    expect(screen.queryByText('private provider details')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /check availability again/i })[0]);
    await screen.findByText(/Task assistance is available/i);
    expect(screen.getByRole('button', { name: 'Suggest quadrant' })).toBeEnabled();
  });

  it('ignores a capability rejection after unmount cancels the request', async () => {
    let rejectCapabilities!: (reason: unknown) => void;
    mockedApi.getCapabilities.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCapabilities = reject;
        })
    );
    const view = renderTools();

    view.unmount();
    await act(async () => {
      rejectCapabilities(
        Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' })
      );
    });
  });
});
