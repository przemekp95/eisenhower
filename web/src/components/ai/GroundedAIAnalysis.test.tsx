import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GroundedAIAnalysis from './GroundedAIAnalysis';
import * as api from '../../services/api';
import { LanguageProvider, useLanguage } from '../../i18n/LanguageContext';

jest.mock('../../services/api');

const mockedApi = jest.mocked(api);

function renderAnalysis(
  taskTitle = 'prepare incident review',
  overrides: Partial<React.ComponentProps<typeof GroundedAIAnalysis>> = {}
) {
  return render(
    <LanguageProvider>
      <GroundedAIAnalysis taskTitle={taskTitle} {...overrides} />
    </LanguageProvider>
  );
}

function groundedResult(overrides: Partial<api.KnowledgeAnswer> = {}): api.KnowledgeAnswer {
  return {
    status: 'answered',
    answer: 'The cited incident policy requires an immediate review.',
    claims: [{ statement: 'The policy requires a review.', citation_ids: ['chunk-1'] }],
    citations: [
      {
        chunk_id: 'chunk-1',
        document_id: 'document-1',
        source_uri: 'eisenhower://repository/<script>alert(1)</script>',
        title: '<img src=x onerror=alert(1)> Incident policy',
        excerpt: '<script>window.compromised = true</script> Follow the incident policy.',
        score: 0.876,
        content_version: 'v1',
      },
    ],
    retrieval: { hit_count: 1, top_score: 0.876, embedding_version: 'minilm-v1' },
    no_answer_reason: null,
    ...overrides,
  };
}

describe('GroundedAIAnalysis', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    localStorage.setItem('eisenhower-language', 'en');
  });

  it('renders a sourced answer and escaped citations without technical diagnostics', async () => {
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());
    renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));

    await waitFor(() => expect(screen.getByText('Answer with sources')).toBeInTheDocument());
    expect(mockedApi.answerKnowledge).toHaveBeenCalledWith(
      'prepare incident review',
      'en',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(screen.queryByText('1 retrieved chunks')).not.toBeInTheDocument();
    expect(screen.queryByText('Index minilm-v1')).not.toBeInTheDocument();
    expect(
      screen.getByText('The cited incident policy requires an immediate review.')
    ).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)> Incident policy')).toBeInTheDocument();
    expect(screen.getByText(/<script>window.compromised/)).toBeInTheDocument();
    expect(screen.queryByText('Score 0.88')).not.toBeInTheDocument();
    expect(screen.queryByText(/eisenhower:\/\/repository/)).not.toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('uses an editable question instead of silently treating the task title as the query', async () => {
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());
    renderAnalysis();

    const question = screen.getByRole('textbox', { name: 'Question for the assistant' });
    expect(question).toHaveValue('prepare incident review');
    fireEvent.change(question, { target: { value: 'Which approved procedure applies?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));

    await waitFor(() =>
      expect(mockedApi.answerKnowledge).toHaveBeenCalledWith(
        'Which approved procedure applies?',
        'en',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
  });

  it('previews and explicitly confirms applying an answer to the task description', async () => {
    const onApplyDescription = jest.fn().mockResolvedValue(undefined);
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());
    renderAnalysis('prepare incident review', {
      taskDescription: 'Existing context',
      onApplyDescription,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await screen.findByText('The cited incident policy requires an immediate review.');
    fireEvent.click(screen.getByRole('button', { name: 'Use in task description' }));

    const preview = screen.getByRole('textbox', { name: 'Description preview' });
    expect(preview).toHaveValue(
      'Existing context\n\nThe cited incident policy requires an immediate review.'
    );
    expect(onApplyDescription).not.toHaveBeenCalled();
    fireEvent.change(preview, { target: { value: 'Reviewed final description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm description update' }));

    await waitFor(() =>
      expect(onApplyDescription).toHaveBeenCalledWith('Reviewed final description')
    );
    expect(screen.getByRole('status')).toHaveTextContent('Task description updated');
  });

  it('keeps the description preview recoverable when applying fails', async () => {
    const onApplyDescription = jest.fn().mockRejectedValue(new Error('revision conflict'));
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());
    renderAnalysis('prepare incident review', { onApplyDescription });

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await screen.findByText('The cited incident policy requires an immediate review.');
    fireEvent.click(screen.getByRole('button', { name: 'Use in task description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm description update' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The task could not be updated')
    );
    expect(screen.getByRole('textbox', { name: 'Description preview' })).toBeInTheDocument();
  });

  it('cancels a staged description without applying it', async () => {
    const onApplyDescription = jest.fn();
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());
    renderAnalysis('prepare incident review', { onApplyDescription });
    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await screen.findByText('The cited incident policy requires an immediate review.');
    fireEvent.click(screen.getByRole('button', { name: 'Use in task description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Description preview' })).not.toBeInTheDocument();
    expect(onApplyDescription).not.toHaveBeenCalled();
  });

  it('shows loading and then an honest no-answer without invented sources', async () => {
    let resolveRequest: (result: api.KnowledgeAnswer) => void = () => undefined;
    mockedApi.answerKnowledge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    expect(screen.getByRole('button', { name: 'Checking approved knowledge...' })).toBeDisabled();

    await act(async () => {
      resolveRequest(
        groundedResult({
          status: 'insufficient_evidence',
          answer: null,
          claims: [],
          citations: [],
          retrieval: { hit_count: 0, top_score: null, embedding_version: null },
          no_answer_reason: 'generation_disabled',
        })
      );
    });

    expect(screen.getByText('No answer')).toBeInTheDocument();
    expect(screen.getByText(/not enough approved information/i)).toBeInTheDocument();
    expect(screen.getByText('No sources were cited for this response.')).toBeInTheDocument();
    expect(screen.queryByText(/Suggested quadrant:/)).not.toBeInTheDocument();
  });

  it('lets the user cancel an in-flight source check without showing an error', () => {
    let signal: AbortSignal | undefined;
    mockedApi.answerKnowledge.mockImplementationOnce((_question, _language, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });
    renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel source check' }));

    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Check sources' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a late successful response after the user cancels the source check', async () => {
    let resolveRequest!: (result: api.KnowledgeAnswer) => void;
    mockedApi.answerKnowledge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel source check' }));
    await act(async () => {
      resolveRequest(groundedResult());
    });

    expect(screen.queryByTestId('grounded-result')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check sources' })).toBeEnabled();
  });

  it('renders no-answer with and without a policy reason', async () => {
    mockedApi.answerKnowledge
      .mockResolvedValueOnce(
        groundedResult({
          status: 'insufficient_evidence',
          answer: null,
          claims: [],
          citations: [],
          retrieval: { hit_count: 0, top_score: null, embedding_version: null },
          no_answer_reason: 'insufficient_context',
        })
      )
      .mockResolvedValueOnce(
        groundedResult({
          status: 'insufficient_evidence',
          answer: null,
          claims: [],
          citations: [],
          retrieval: { hit_count: 0, top_score: null, embedding_version: null },
          no_answer_reason: null,
        })
      );
    renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() =>
      expect(screen.getByText(/Try a more specific question/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/insufficient_evidence/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() =>
      expect(screen.queryByText(/insufficient_evidence/)).not.toBeInTheDocument()
    );
    expect(screen.getByText(/not enough approved information/i)).toBeInTheDocument();
  });

  it('reports typed and unknown failures and clears stale output', async () => {
    mockedApi.answerKnowledge
      .mockResolvedValueOnce(groundedResult())
      .mockRejectedValueOnce(new Error('Private RAG unavailable'))
      .mockRejectedValueOnce('offline');
    const view = renderAnalysis();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() => expect(screen.getByText('Answer with sources')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The sources could not be checked')
    );
    expect(screen.queryByTestId('grounded-result')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The sources could not be checked')
    );

    view.rerender(
      <LanguageProvider>
        <GroundedAIAnalysis taskTitle="changed task" />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('silently ignores a cancelled source check after the task changes', async () => {
    let rejectRequest!: (reason: unknown) => void;
    mockedApi.answerKnowledge.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        })
    );
    const view = renderAnalysis('old task');

    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    view.rerender(
      <LanguageProvider>
        <GroundedAIAnalysis taskTitle="new task" />
      </LanguageProvider>
    );
    await act(async () => {
      rejectRequest(Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' }));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not submit an empty task and clears results after a language change', async () => {
    mockedApi.answerKnowledge.mockResolvedValueOnce(groundedResult());

    function Harness() {
      const { setLanguage } = useLanguage();
      return (
        <>
          <button type="button" onClick={() => setLanguage('pl')}>
            switch language
          </button>
          <GroundedAIAnalysis taskTitle="prepare incident review" />
        </>
      );
    }

    const view = render(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await waitFor(() => expect(screen.getByText('Answer with sources')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'switch language' }));
    await waitFor(() => expect(screen.queryByTestId('grounded-result')).not.toBeInTheDocument());

    view.unmount();
    localStorage.setItem('eisenhower-language', 'en');
    const empty = renderAnalysis('   ');
    const disabled = screen.getByRole('button', { name: 'Check sources' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(mockedApi.answerKnowledge).toHaveBeenCalledTimes(1);
    empty.unmount();
  });
});
