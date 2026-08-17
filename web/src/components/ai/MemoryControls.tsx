import { useState } from 'react';
import {
  confirmMemory,
  exportMemory,
  prepareMemory,
  type MemoryConsentReceipt,
  type MemoryExportResponseDto,
  type MemoryIntentDto,
} from '../../services/api';
import { useLanguage } from '../../i18n/LanguageContext';

type PreparedMutation = {
  intent: MemoryIntentDto;
  receipt: MemoryConsentReceipt;
  idempotencyKey: string;
};

const safeId = (prefix: string) => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${random.replace(/[^A-Za-z0-9.-]/g, '')}`;
};

export default function MemoryControls() {
  const { t } = useLanguage();
  const [content, setContent] = useState('');
  const [preparedCreate, setPreparedCreate] = useState<PreparedMutation | null>(null);
  const [preparedLifecycle, setPreparedLifecycle] = useState<PreparedMutation | null>(null);
  const [exported, setExported] = useState<MemoryExportResponseDto | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'confirm' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const refreshExport = async () => {
    setBusy('export');
    setError('');
    try {
      setExported(await exportMemory());
    } catch {
      setError(t('ai.memory.export.failed'));
    } finally {
      setBusy(null);
    }
  };

  const prepareCreate = async () => {
    const normalized = content.trim();
    if (!normalized) {
      setError(t('ai.memory.validation'));
      return;
    }
    const memoryId = safeId('preference');
    const intent: MemoryIntentDto = {
      action: 'create',
      memory_id: memoryId,
      memory_type: 'communication_preference',
      conflict_key: 'response-style',
      content: normalized,
      source_event_id: safeId('web-memory'),
      provenance: 'explicit web memory control',
      confidence: 1,
      salience: 0.8,
      retention_class: 'user_controlled',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    setBusy('prepare');
    setError('');
    setStatus('');
    try {
      const prepared = await prepareMemory(intent);
      setPreparedCreate({
        intent,
        receipt: prepared.receipt,
        idempotencyKey: safeId('memory-create'),
      });
    } catch {
      setError(t('ai.memory.prepare.failed'));
    } finally {
      setBusy(null);
    }
  };

  const confirmPrepared = async (
    prepared: PreparedMutation,
    clear: () => void,
    successKey: 'ai.memory.create.success' | 'ai.memory.revoke.success' | 'ai.memory.delete.success'
  ) => {
    setBusy('confirm');
    setError('');
    setStatus('');
    try {
      await confirmMemory(prepared.intent, prepared.receipt, prepared.idempotencyKey);
      clear();
      if (prepared.intent.action === 'create') setContent('');
      setStatus(t(successKey));
      await refreshExport();
    } catch (issue) {
      const statusCode =
        issue && typeof issue === 'object' && 'status' in issue ? issue.status : undefined;
      setError(
        statusCode === 409 ? t('ai.memory.confirm.conflict') : t('ai.memory.confirm.failed')
      );
      setBusy(null);
    }
  };

  const prepareLifecycle = async (memoryId: string, action: 'revoke' | 'delete') => {
    const intent: MemoryIntentDto = { action, memory_id: memoryId };
    setBusy('prepare');
    setError('');
    setStatus('');
    try {
      const prepared = await prepareMemory(intent);
      setPreparedLifecycle({
        intent,
        receipt: prepared.receipt,
        idempotencyKey: safeId(`memory-${action}`),
      });
    } catch {
      setError(t('ai.memory.prepare.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="memory-controls-title" className="space-y-6">
      <div>
        <h3 id="memory-controls-title" className="text-lg font-semibold">
          {t('ai.memory.title')}
        </h3>
        <p className="mt-1 text-sm leading-6 text-white/60">{t('ai.memory.description')}</p>
      </div>

      <div className="space-y-3 border-b border-white/10 pb-6">
        <label className="block text-sm font-medium" htmlFor="memory-preference">
          {t('ai.memory.preference')}
        </label>
        <textarea
          id="memory-preference"
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setPreparedCreate(null);
          }}
          rows={3}
          maxLength={2000}
          className="w-full resize-y rounded-2xl border border-white/10 bg-white/7 px-4 py-3 text-white outline-none transition focus:border-cyan-200/45 focus:ring-2 focus:ring-cyan-200/15"
          placeholder={t('ai.memory.preference.placeholder')}
        />
        <p className="text-xs leading-5 text-white/50">{t('ai.memory.retention')}</p>
        <button
          type="button"
          onClick={prepareCreate}
          disabled={busy !== null}
          className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-50"
        >
          {busy === 'prepare' ? t('ai.memory.preparing') : t('ai.memory.prepare')}
        </button>
      </div>

      {preparedCreate ? (
        <div className="space-y-3 border-b border-cyan-200/20 pb-6" aria-live="polite">
          <h4 className="font-semibold">{t('ai.memory.preview.title')}</h4>
          <p className="whitespace-pre-wrap text-sm leading-6 text-white/80">
            {preparedCreate.intent.action === 'create' ? preparedCreate.intent.content : ''}
          </p>
          <p className="text-xs leading-5 text-cyan-100/70">{t('ai.memory.preview.receipt')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void confirmPrepared(
                  preparedCreate,
                  () => setPreparedCreate(null),
                  'ai.memory.create.success'
                )
              }
              disabled={busy !== null}
              className="rounded-full bg-cyan-200 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {busy === 'confirm' ? t('ai.memory.confirming') : t('ai.memory.confirmCreate')}
            </button>
            <button
              type="button"
              onClick={() => setPreparedCreate(null)}
              disabled={busy !== null}
              className="rounded-full px-4 py-2 text-sm text-white/70 hover:bg-white/10"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-semibold">{t('ai.memory.export.title')}</h4>
          <button
            type="button"
            onClick={() => void refreshExport()}
            disabled={busy !== null}
            className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-50"
          >
            {busy === 'export' ? t('ai.memory.exporting') : t('ai.memory.export')}
          </button>
        </div>
        {exported?.items.length === 0 ? (
          <p className="text-sm text-white/55">{t('ai.memory.export.empty')}</p>
        ) : null}
        {exported?.items.map((item) => (
          <article key={item.memory_id} className="space-y-3 border-t border-white/10 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm leading-6 text-white/85">{item.content}</p>
                <p className="mt-1 text-xs text-white/45">{item.status}</p>
              </div>
              {item.status !== 'deleted' ? (
                <div className="flex flex-wrap gap-2">
                  {item.status === 'active' ? (
                    <button
                      type="button"
                      onClick={() => void prepareLifecycle(item.memory_id, 'revoke')}
                      disabled={busy !== null}
                      className="rounded-full border border-amber-200/25 px-3 py-1.5 text-xs text-amber-100 disabled:opacity-50"
                    >
                      {t('ai.memory.revoke.review')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void prepareLifecycle(item.memory_id, 'delete')}
                    disabled={busy !== null}
                    className="rounded-full border border-rose-200/25 px-3 py-1.5 text-xs text-rose-100 disabled:opacity-50"
                  >
                    {t('ai.memory.delete.review')}
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {preparedLifecycle ? (
        <div className="space-y-3 border-t border-amber-200/20 pt-4" role="group">
          <p className="font-medium">
            {preparedLifecycle.intent.action === 'revoke'
              ? t('ai.memory.revoke.question')
              : t('ai.memory.delete.question')}
          </p>
          <p className="text-sm leading-6 text-white/60">{t('ai.memory.lifecycle.receipt')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void confirmPrepared(
                  preparedLifecycle,
                  () => setPreparedLifecycle(null),
                  preparedLifecycle.intent.action === 'revoke'
                    ? 'ai.memory.revoke.success'
                    : 'ai.memory.delete.success'
                )
              }
              disabled={busy !== null}
              className="rounded-full bg-amber-200 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {preparedLifecycle.intent.action === 'revoke'
                ? t('ai.memory.revoke.confirm')
                : t('ai.memory.delete.confirm')}
            </button>
            <button
              type="button"
              onClick={() => setPreparedLifecycle(null)}
              disabled={busy !== null}
              className="rounded-full px-4 py-2 text-sm text-white/70 hover:bg-white/10"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm leading-6 text-rose-200">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm leading-6 text-emerald-200">
          {status}
        </p>
      ) : null}
    </section>
  );
}
