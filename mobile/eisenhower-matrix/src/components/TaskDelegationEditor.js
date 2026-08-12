import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import styles from '../styles/appStyles';
import { delegationStatusActions, validateDelegationAssignment } from '../utils/taskDelegation';

function draftFrom(delegation) {
  return {
    assigneeUserId: delegation?.assigneeUserId || '',
    displayLabel: delegation?.displayLabel || '',
    handoffNote: delegation?.handoffNote || '',
  };
}

export default function TaskDelegationEditor({
  taskId, delegation, role, onAssign, onCancel, onStatus, t,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(delegation));
  const [error, setError] = useState('');

  if (role === 'assignee') {
    return (
      <View style={styles.scheduleBox}>
        <Text style={styles.cardDescription}>{t.delegationFrom}: {delegation?.displayLabel || t.delegationUnknown}</Text>
        <Text style={styles.pendingSyncBadge}>{t.delegationStatus}: {t[`delegationStatus_${delegation?.status}`]}</Text>
        {delegation?.handoffNote ? <Text style={styles.cardDescription}>{delegation.handoffNote}</Text> : null}
        <View style={styles.actions}>
          {delegationStatusActions(delegation?.status).map((status) => (
            <Pressable
              key={status}
              testID={`delegation-status-${status}-${taskId}`}
              accessibilityRole="button"
              onPress={() => onStatus(taskId, status)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{t[`delegationAction_${status}`]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  const open = () => {
    setDraft(draftFrom(delegation));
    setError('');
    setEditing(true);
  };
  const save = () => {
    const result = validateDelegationAssignment(draft);
    if (!result.valid) {
      setError(t.delegationInvalid);
      return;
    }
    setEditing(false);
    onAssign(taskId, result.delegation);
  };

  return (
    <View style={styles.scheduleBox}>
      {delegation ? (
        <Text style={styles.cardDescription}>
          {t.delegationAssignedTo}: {delegation.displayLabel} · {t[`delegationStatus_${delegation.status || 'offered'}`]}
        </Text>
      ) : <Text style={styles.cardDescription}>{t.delegationNone}</Text>}
      {editing ? (
        <View style={styles.scheduleEditor}>
          <TextInput testID={`delegation-user-${taskId}`} accessibilityLabel={t.delegationUserInput}
            autoCapitalize="none" value={draft.assigneeUserId}
            onChangeText={(assigneeUserId) => setDraft((current) => ({ ...current, assigneeUserId }))}
            style={styles.input} />
          <TextInput testID={`delegation-label-${taskId}`} accessibilityLabel={t.delegationLabelInput}
            value={draft.displayLabel}
            onChangeText={(displayLabel) => setDraft((current) => ({ ...current, displayLabel }))}
            style={styles.input} />
          <TextInput testID={`delegation-note-${taskId}`} accessibilityLabel={t.delegationNoteInput}
            value={draft.handoffNote} multiline
            onChangeText={(handoffNote) => setDraft((current) => ({ ...current, handoffNote }))}
            style={styles.input} />
          {error ? <Text accessibilityRole="alert" style={styles.scheduleError}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable testID={`delegation-save-${taskId}`} accessibilityRole="button" onPress={save} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{t.delegationSave}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setEditing(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable testID={`delegation-edit-${taskId}`} accessibilityRole="button" onPress={open} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{delegation ? t.delegationReassign : t.delegationAssign}</Text>
          </Pressable>
          {delegation ? (
            <Pressable testID={`delegation-cancel-${taskId}`} accessibilityRole="button" onPress={() => onCancel(taskId)} style={styles.deleteButton}>
              <Text style={styles.deleteButtonText}>{t.delegationCancel}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
