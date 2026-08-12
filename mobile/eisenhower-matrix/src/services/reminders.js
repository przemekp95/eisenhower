import * as Notifications from 'expo-notifications';

const CHANNEL_ID = 'task-reminders';

async function cancelExisting(notificationId) {
  if (typeof notificationId === 'string' && notificationId) {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  }
}

async function ensureChannel() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Przypomnienia o zadaniach',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

async function hasPermission(requestPermission) {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') return true;
  if (!requestPermission) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

export async function syncTaskReminder(task, {
  now = new Date(),
  requestPermission = false,
} = {}) {
  await cancelExisting(task?.notificationId);
  const remindAt = task?.schedule?.remindAt;
  const lifecycleState = task?.lifecycleState || 'active';
  if (!remindAt || lifecycleState !== 'active') {
    return { status: 'disabled', notificationId: null };
  }
  if (Date.parse(remindAt) <= now.getTime()) {
    return { status: 'missed', notificationId: null };
  }

  await ensureChannel();
  if (!(await hasPermission(requestPermission))) {
    return { status: 'permission_denied', notificationId: null };
  }

  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Eisenhower',
      body: 'Masz zaplanowane przypomnienie.',
      data: { taskId: String(task.id) },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(remindAt),
      channelId: CHANNEL_ID,
    },
  });
  return { status: 'scheduled', notificationId };
}

export async function resyncTaskReminders(tasks, options = {}) {
  return Promise.all((Array.isArray(tasks) ? tasks : []).map(async (task) => {
    try {
      const result = await syncTaskReminder(task, { ...options, requestPermission: false });
      const { notificationId: _oldNotificationId, reminderStatus: _oldStatus, ...rest } = task;
      return {
        ...rest,
        ...(result.notificationId ? { notificationId: result.notificationId } : {}),
        reminderStatus: result.status,
      };
    } catch {
      return { ...task, reminderStatus: 'error' };
    }
  }));
}
