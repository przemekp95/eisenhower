import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import styles from '../styles/appStyles';

export default function MatrixBoard({
  quadrantOptions,
  groupedTasks,
  onDelete,
  onResolveConflict,
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
                      {confirmDeleteId === item.id ? (
                        <View accessibilityRole="alert" style={styles.deleteConfirmation}>
                          <Text style={styles.deleteConfirmationText}>
                            {t.confirmPermanentDelete.replace('{title}', item.title)}
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
                      ) : (
                        <Pressable
                          testID={`delete-task-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${t.permanentDelete}: ${item.title}`}
                          onPress={() => setConfirmDeleteId(item.id)}
                          style={styles.deleteButton}
                        >
                          <Text style={styles.deleteButtonText}>{t.permanentDelete}</Text>
                        </Pressable>
                      )}
                    </View>
                    <View style={styles.badges}>
                      <Pressable
                        testID={`toggle-urgent-${item.id}`}
                        onPress={() => onToggle(item.id, 'urgent')}
                        disabled={item.syncState === 'conflict'}
                        accessibilityRole="switch"
                        accessibilityLabel={`${t.urgent}: ${item.title}`}
                        accessibilityState={{ checked: item.urgent, disabled: item.syncState === 'conflict' }}
                        style={styles.badge}
                      >
                        <Text style={styles.badgeText}>{t.urgent}: {item.urgent ? t.on : t.off}</Text>
                      </Pressable>
                      <Pressable
                        testID={`toggle-important-${item.id}`}
                        onPress={() => onToggle(item.id, 'important')}
                        disabled={item.syncState === 'conflict'}
                        accessibilityRole="switch"
                        accessibilityLabel={`${t.important}: ${item.title}`}
                        accessibilityState={{ checked: item.important, disabled: item.syncState === 'conflict' }}
                        style={styles.badge}
                      >
                        <Text style={styles.badgeText}>{t.important}: {item.important ? t.on : t.off}</Text>
                      </Pressable>
                    </View>
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
