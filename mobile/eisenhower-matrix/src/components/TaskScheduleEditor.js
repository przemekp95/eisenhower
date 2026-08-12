import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import styles from '../styles/appStyles';
import { formatTaskSchedule, validateTaskSchedule } from '../utils/taskSchedule';

function initialDraft(schedule) {
  return {
    dueAt: schedule?.dueAt || '',
    timeZone: schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    remindAt: schedule?.remindAt || '',
  };
}

export default function TaskScheduleEditor({ taskId, schedule, onSave, onClear, t }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => initialDraft(schedule));
  const [error, setError] = useState('');

  const open = () => {
    setDraft(initialDraft(schedule));
    setError('');
    setEditing(true);
  };
  const save = () => {
    const candidate = {
      dueAt: draft.dueAt.trim(),
      timeZone: draft.timeZone.trim(),
      ...(draft.remindAt.trim() ? { remindAt: draft.remindAt.trim() } : {}),
    };
    const result = validateTaskSchedule(candidate);
    if (!result.valid) {
      setError(t.scheduleInvalid);
      return;
    }
    setError('');
    setEditing(false);
    onSave(taskId, result.schedule);
  };

  return (
    <View style={styles.scheduleBox}>
      {schedule ? (
        <Text testID={`schedule-display-${taskId}`} style={styles.cardDescription}>
          {t.scheduleDue}: {formatTaskSchedule(schedule, t.languageCode)} ({schedule.timeZone})
        </Text>
      ) : <Text style={styles.cardDescription}>{t.scheduleNone}</Text>}
      {schedule?.remindAt ? (
        <Text style={styles.cardDescription}>{t.scheduleReminder}: {schedule.remindAt}</Text>
      ) : null}
      {editing ? (
        <View style={styles.scheduleEditor}>
          <TextInput
            testID={`schedule-due-${taskId}`}
            accessibilityLabel={t.scheduleDueInput}
            autoCapitalize="none"
            value={draft.dueAt}
            onChangeText={(dueAt) => setDraft((current) => ({ ...current, dueAt }))}
            placeholder="2026-08-15T12:00:00.000Z"
            placeholderTextColor="#64748b"
            style={styles.input}
          />
          <TextInput
            testID={`schedule-timezone-${taskId}`}
            accessibilityLabel={t.scheduleTimeZoneInput}
            autoCapitalize="none"
            value={draft.timeZone}
            onChangeText={(timeZone) => setDraft((current) => ({ ...current, timeZone }))}
            placeholder="Europe/Warsaw"
            placeholderTextColor="#64748b"
            style={styles.input}
          />
          <TextInput
            testID={`schedule-reminder-${taskId}`}
            accessibilityLabel={t.scheduleReminderInput}
            autoCapitalize="none"
            value={draft.remindAt}
            onChangeText={(remindAt) => setDraft((current) => ({ ...current, remindAt }))}
            placeholder="2026-08-15T10:00:00.000Z"
            placeholderTextColor="#64748b"
            style={styles.input}
          />
          {error ? <Text accessibilityRole="alert" style={styles.scheduleError}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable testID={`schedule-save-${taskId}`} accessibilityRole="button" onPress={save} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{t.scheduleSave}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setEditing(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable testID={`schedule-edit-${taskId}`} accessibilityRole="button" onPress={open} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{schedule ? t.scheduleEdit : t.scheduleAdd}</Text>
          </Pressable>
          {schedule ? (
            <Pressable testID={`schedule-clear-${taskId}`} accessibilityRole="button" onPress={() => onClear(taskId)} style={styles.deleteButton}>
              <Text style={styles.deleteButtonText}>{t.scheduleClear}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
