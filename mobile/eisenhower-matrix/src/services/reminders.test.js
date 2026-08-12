jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  cancelScheduledNotificationAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
}), { virtual: true });

import * as Notifications from 'expo-notifications';
import { resyncTaskReminders, syncTaskReminder } from './reminders';

describe('private local reminders', () => {
  const futureTask = {
    id: 'task-1',
    lifecycleState: 'active',
    schedule: {
      dueAt: '2026-08-15T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
      remindAt: '2026-08-15T10:00:00.000Z',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Notifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Notifications.scheduleNotificationAsync.mockResolvedValue('native-1');
    Notifications.setNotificationChannelAsync.mockResolvedValue(null);
  });

  it('schedules generic content without task text and creates the Android channel first', async () => {
    await expect(syncTaskReminder(futureTask, {
      now: new Date('2026-08-12T10:00:00.000Z'),
      requestPermission: true,
    })).resolves.toEqual({ status: 'scheduled', notificationId: 'native-1' });

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({
        title: 'Eisenhower',
        body: 'Masz zaplanowane przypomnienie.',
        data: { taskId: 'task-1' },
      }),
      trigger: expect.objectContaining({ type: 'date', channelId: 'task-reminders' }),
    });
    expect(JSON.stringify(Notifications.scheduleNotificationAsync.mock.calls[0][0]))
      .not.toContain('private task title');
  });

  it('returns permission_denied without failing or scheduling', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    Notifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(syncTaskReminder(futureTask, {
      now: new Date('2026-08-12T10:00:00.000Z'),
      requestPermission: true,
    })).resolves.toEqual({ status: 'permission_denied', notificationId: null });
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels stale native ids and deterministically marks missed reminders', async () => {
    await expect(syncTaskReminder({ ...futureTask, notificationId: 'old-native' }, {
      now: new Date('2026-08-16T10:00:00.000Z'),
    })).resolves.toEqual({ status: 'missed', notificationId: null });
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('old-native');
  });

  it('resyncs on launch without prompting and preserves per-task outcomes', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const [result] = await resyncTaskReminders([futureTask], {
      now: new Date('2026-08-12T10:00:00.000Z'),
    });
    expect(result).toMatchObject({ id: 'task-1', reminderStatus: 'permission_denied' });
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('cancels reminders when a schedule is absent or the task is no longer active', async () => {
    await expect(syncTaskReminder({ id: 'none' }))
      .resolves.toEqual({ status: 'disabled', notificationId: null });
    await expect(syncTaskReminder({ ...futureTask, lifecycleState: 'completed' }))
      .resolves.toEqual({ status: 'disabled', notificationId: null });
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requests permission when explicitly initiated and tolerates per-task native errors on resync', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    Notifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await expect(syncTaskReminder(futureTask, {
      now: new Date('2026-08-12T10:00:00.000Z'),
      requestPermission: true,
    })).resolves.toMatchObject({ status: 'scheduled' });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();

    Notifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Notifications.scheduleNotificationAsync.mockRejectedValueOnce(new Error('native failure'));
    await expect(resyncTaskReminders([futureTask], {
      now: new Date('2026-08-12T10:00:00.000Z'),
    })).resolves.toEqual([expect.objectContaining({ id: 'task-1', reminderStatus: 'error' })]);
    await expect(resyncTaskReminders(null)).resolves.toEqual([]);
  });
});
