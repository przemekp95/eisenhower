import { FormEvent, useRef, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import type { Task, TaskDelegationAssignment, TaskDelegationStatus, TaskView } from '../types';

interface Props {
  task: Task;
  view: TaskView;
  onAssign: (id: string, delegation: TaskDelegationAssignment | null) => Promise<void>;
  onStatus: (id: string, status: TaskDelegationStatus) => Promise<void>;
}

const STATUS_ACTIONS: Record<TaskDelegationStatus, TaskDelegationStatus[]> = {
  offered: ['accepted', 'declined'],
  accepted: ['in_progress', 'declined'],
  in_progress: ['blocked', 'completed'],
  blocked: ['in_progress', 'completed'],
  completed: [],
  declined: [],
};

export default function TaskDelegationPanel({ task, view, onAssign, onStatus }: Props) {
  const { t } = useLanguage();
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [assigneeUserId, setAssigneeUserId] = useState(task.delegation?.assigneeUserId ?? '');
  const [displayLabel, setDisplayLabel] = useState(task.delegation?.displayLabel ?? '');
  const [handoffNote, setHandoffNote] = useState(task.delegation?.handoffNote ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setAssigneeUserId(task.delegation?.assigneeUserId ?? '');
    setDisplayLabel(task.delegation?.displayLabel ?? '');
    setHandoffNote(task.delegation?.handoffNote ?? '');
    setError(null);
    setEditing(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      await onAssign(task._id, {
        assigneeUserId: assigneeUserId.trim(),
        displayLabel: displayLabel.trim(),
        handoffNote: handoffNote.trim(),
      });
      setEditing(false);
      setError(null);
      requestAnimationFrame(() => actionRef.current?.focus());
    } catch {
      setError(t('status.saveError'));
    } finally {
      setPending(false);
    }
  };

  const runStatus = async (status: TaskDelegationStatus) => {
    setPending(true);
    try {
      await onStatus(task._id, status);
      setError(null);
    } catch {
      setError(t('status.saveError'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-white/10 pt-3 text-xs text-white/75">
      <p className="font-semibold uppercase tracking-[0.14em] text-white/50">
        {t('delegation.heading')}
      </p>
      {task.delegation ? (
        <div className="mt-2 space-y-1">
          <p>
            <span className="font-semibold text-white">{task.delegation.displayLabel}</span>{' '}
            <span className="text-white/50">({task.delegation.assigneeUserId})</span>
          </p>
          <p>
            {t('delegation.status')}:{' '}
            <span className="font-semibold text-cyan-100">
              {t(`delegation.status.${task.delegation.status}`)}
            </span>
          </p>
          {task.delegation.handoffNote ? (
            <p className="whitespace-pre-wrap text-white/65">{task.delegation.handoffNote}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-white/50">{t('delegation.none')}</p>
      )}

      {view === 'owned' ? (
        editing ? (
          <form
            onSubmit={submit}
            aria-label={`${t('delegation.assign')} ${task.title}`}
            className="mt-3 grid gap-2 rounded-2xl bg-white/5 p-3"
          >
            <label className="grid gap-1">
              <span>{t('delegation.assigneeId')}</span>
              <input
                required
                maxLength={128}
                value={assigneeUserId}
                onChange={(event) => setAssigneeUserId(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
              />
            </label>
            <label className="grid gap-1">
              <span>{t('delegation.displayLabel')}</span>
              <input
                required
                maxLength={120}
                value={displayLabel}
                onChange={(event) => setDisplayLabel(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
              />
            </label>
            <label className="grid gap-1">
              <span>{t('delegation.note')}</span>
              <textarea
                maxLength={1000}
                value={handoffNote}
                onChange={(event) => setHandoffNote(event.target.value)}
                className="min-h-20 rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-full bg-cyan-200 px-3 py-1.5 font-semibold text-slate-950 disabled:opacity-50"
              >
                {t('delegation.submit')}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-full bg-white/10 px-3 py-1.5"
              >
                {t('task.cancelDelete')}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              ref={actionRef}
              type="button"
              onClick={open}
              aria-label={`${task.delegation ? t('delegation.reassign') : t('delegation.assign')} ${task.title}`}
              className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/15"
            >
              {task.delegation ? t('delegation.reassign') : t('delegation.assign')}
            </button>
            {task.delegation ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => void onAssign(task._id, null)}
                aria-label={`${t('delegation.cancel')} ${task.title}`}
                className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/15 disabled:opacity-50"
              >
                {t('delegation.cancel')}
              </button>
            ) : null}
          </div>
        )
      ) : task.delegation ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {STATUS_ACTIONS[task.delegation.status].map((status) => (
            <button
              key={status}
              type="button"
              disabled={pending}
              onClick={() => void runStatus(status)}
              aria-label={`${t(`delegation.action.${status}`)} ${task.title}`}
              className="rounded-full bg-cyan-200/15 px-3 py-1.5 font-semibold text-cyan-50 hover:bg-cyan-200/25 disabled:opacity-50"
            >
              {t(`delegation.action.${status}`)}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
