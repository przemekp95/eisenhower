import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import TaskScheduleEditor from './TaskScheduleEditor';
import TaskDelegationEditor from './TaskDelegationEditor';
import styles from '../styles/appStyles';

export default function MatrixBoard({
  quadrantOptions,
  groupedTasks,
  onDelete,
  onLifecycle,
  onResolveConflict,
  onSchedule,
  onClearSchedule,
  onDelegation,
  onDelegationStatus,
  taskView = 'owned',
  onToggle,
  t,
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  return (
    <>
      <View style={styles.matrixHeader}>
        <Text style={styles.sectionEyebrow}>{t.matrixTitle}</Text>
        <Text style={styles.matrixSubtitle}>{t.matrixSubtitle}</Text>
      </View>

      <View style={styles.matrixGrid}>
        {quadrantOptions.map((quadrant) => {
          const quadrantTasks = groupedTasks[quadrant.value];

          return (
            <View
              key={quadrant.value}
              testID={`quadrant-${quadrant.value}`}
              style={[styles.quadrantCard, { borderColor: quadrant.accent }]}
            >
              <View style={styles.quadrantHeader}>
                <View style={[styles.quadrantMarker, { backgroundColor: quadrant.accent }]} />
                <View style={styles.quadrantCopy}>
                  <Text accessibilityRole="header" style={styles.quadrantTitle}>{quadrant.title}</Text>
                  <Text style={styles.quadrantHint}>{quadrant.hint}</Text>
                </View>
                <Text style={styles.quadrantCount}>{quadrantTasks.length}</Text>
              </View>

              {quadrantTasks.length === 0 ? (
                <View style={styles.emptyQuadrant}>
                  <Text style={styles.emptyQuadrantText}>{t.quadrantEmpty}</Text>
                </View>
              ) : (
                quadrantTasks.map((item) => (
                  <View key={item.id} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>{item.title}</Text>
                        {item.description ? (
                          <Text style={styles.cardDescription}>{item.description}</Text>
                        ) : null}
                        <Text testID={`lifecycle-state-${item.id}`} style={styles.pendingSyncBadge}>
                          {t.lifecycleState}: {t[`lifecycleState_${item.lifecycleState || 'active'}`]}
                        </Text>
                        {item.syncState && item.syncState !== 'synced' && item.syncState !== 'local_seed' ? (
                          <Text testID={`sync-pending-${item.id}`} style={styles.pendingSyncBadge}>
                            {item.syncError === 'conflict'
                              ? t.syncConflict
                              : item.syncError === 'error'
                                ? t.syncError
                                : t.pendingSync}
                          </Text>
                        ) : null}
                        {item.syncState === 'conflict' ? (
                          <View style={styles.actions}>
                            <Pressable
                              testID={`conflict-keep-remote-${item.id}`}
                              accessibilityRole="button"
                              onPress={() => onResolveConflict(item.id, 'remote')}
                              style={styles.secondaryButton}
                            >
                              <Text style={styles.secondaryButtonText}>{t.conflictKeepRemote}</Text>
                            </Pressable>
                            <Pressable
                              testID={`conflict-retry-local-${item.id}`}
                              accessibilityRole="button"
                              onPress={() => onResolveConflict(item.id, 'local')}
                              style={styles.toolsButton}
                            >
                              <Text style={styles.toolsButtonText}>{t.conflictRetryLocal}</Text>
                            </Pressable>
                          </View>
                        ) : null}
                      </View>
                      {taskView === 'owned' && (item.lifecycleState || 'active') === 'trashed' && confirmDeleteId === item.id ? (
                        <View accessibilityRole="alert" style={styles.deleteConfirmation}>
                          <Text style={styles.deleteConfirmationText}>
                            {t.confirmTrashPurge.replace('{title}', item.title)}
                          </Text>
                          <View style={styles.actions}>
                            <Pressable
                              testID={`confirm-delete-${item.id}`}
                              accessibilityRole="button"
                              accessibilityLabel={t.confirmDeleteAction}
                              onPress={() => {
                                setConfirmDeleteId(null);
                                onDelete(item.id);
                              }}
                              style={styles.deleteButton}
                            >
                              <Text style={styles.deleteButtonText}>{t.confirmDeleteAction}</Text>
                            </Pressable>
                            <Pressable
                              testID={`cancel-delete-${item.id}`}
                              accessibilityRole="button"
                              onPress={() => setConfirmDeleteId(null)}
                              style={styles.secondaryButton}
                            >
                              <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
                            </Pressable>
                          </View>
                        </View>
                      ) : taskView === 'owned' && (item.lifecycleState || 'active') === 'trashed' ? (
                        <Pressable
                          testID={`delete-task-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.permanentDelete}: ${item.title}`}
                          accessibilityState={{ disabled: item.syncState === 'conflict' }}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => setConfirmDeleteId(item.id)}
                          style={styles.deleteButton}
                        >
                          <Text style={styles.deleteButtonText}>{t.permanentDelete}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {taskView === 'owned' ? <View style={styles.actions}>
                      {(item.lifecycleState || 'active') === 'active' ? (
                        <Pressable
                          testID={`lifecycle-complete-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.completeTask}: ${item.title}`}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => onLifecycle(item.id, 'complete')}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>{t.completeTask}</Text>
                        </Pressable>
                      ) : null}
                      {item.lifecycleState === 'completed' ? (
                        <Pressable
                          testID={`lifecycle-reopen-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.reopenTask}: ${item.title}`}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => onLifecycle(item.id, 'reopen')}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>{t.reopenTask}</Text>
                        </Pressable>
                      ) : null}
                      {['active', 'completed'].includes(item.lifecycleState || 'active') ? (
                        <Pressable
                          testID={`lifecycle-archive-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.archiveTask}: ${item.title}`}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => onLifecycle(item.id, 'archive')}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>{t.archiveTask}</Text>
                        </Pressable>
                      ) : null}
                      {['archived', 'trashed'].includes(item.lifecycleState) ? (
                        <Pressable
                          testID={`lifecycle-restore-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.restoreTask}: ${item.title}`}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => onLifecycle(item.id, 'restore')}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>{t.restoreTask}</Text>
                        </Pressable>
                      ) : null}
                      {item.lifecycleState !== 'trashed' ? (
                        <Pressable
                          testID={`lifecycle-trash-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.moveToTrash}: ${item.title}`}
                          disabled={item.syncState === 'conflict'}
                          onPress={() => onLifecycle(item.id, 'trash')}
                          style={styles.deleteButton}
                        >
                          <Text style={styles.deleteButtonText}>{t.moveToTrash}</Text>
                        </Pressable>
                      ) : null}
                    </View> : null}
                    {taskView === 'owned' && item.lifecycleState !== 'trashed' ? (
                      <TaskScheduleEditor
                        taskId={item.id}
                        schedule={item.schedule}
                        onSave={onSchedule}
                        onClear={onClearSchedule}
                        t={t}
                      />
                    ) : null}
                    <TaskDelegationEditor
                      taskId={item.id}
                      delegation={item.delegation}
                      role={taskView === 'delegated' ? 'assignee' : 'owner'}
                      onAssign={onDelegation}
                      onCancel={(id) => onDelegation(id, null)}
                      onStatus={onDelegationStatus}
                      t={t}
                    />
                    {item.reminderStatus === 'permission_denied' ? (
                      <Text accessibilityRole="alert" style={styles.scheduleError}>
                        {t.reminderPermissionDenied}
                      </Text>
                    ) : null}
                    {item.reminderStatus === 'missed' ? (
                      <Text accessibilityRole="alert" style={styles.scheduleError}>
                        {t.reminderMissed}
                      </Text>
                    ) : null}
                    {taskView === 'owned' ? <View style={styles.badges}>
                      <Pressable
                        testID={`toggle-urgent-${item.id}`}
                        onPress={() => onToggle(item.id, 'urgent')}
                        disabled={item.syncState === 'conflict' || item.lifecycleState === 'trashed'}
                        accessibilityRole="switch"
                        accessibilityLabel={`${t.urgent}: ${item.title}`}
                        accessibilityState={{ checked: item.urgent, disabled: item.syncState === 'conflict' || item.lifecycleState === 'trashed' }}
                        style={styles.badge}
                      >
                        <Text style={styles.badgeText}>{t.urgent}: {item.urgent ? t.on : t.off}</Text>
                      </Pressable>
                      <Pressable
                        testID={`toggle-important-${item.id}`}
                        onPress={() => onToggle(item.id, 'important')}
                        disabled={item.syncState === 'conflict' || item.lifecycleState === 'trashed'}
                        accessibilityRole="switch"
                        accessibilityLabel={`${t.important}: ${item.title}`}
                        accessibilityState={{ checked: item.important, disabled: item.syncState === 'conflict' || item.lifecycleState === 'trashed' }}
                        style={styles.badge}
                      >
                        <Text style={styles.badgeText}>{t.important}: {item.important ? t.on : t.off}</Text>
                      </Pressable>
                    </View> : null}
                  </View>
                ))
              )}
            </View>
          );
        })}
      </View>
    </>
  );
}
