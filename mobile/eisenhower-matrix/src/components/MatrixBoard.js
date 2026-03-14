import React from 'react';
import { Pressable, Text, View } from 'react-native';
import styles from '../styles/appStyles';

export default function MatrixBoard({
  quadrantOptions,
  groupedTasks,
  onDelete,
  onToggle,
  t,
}) {
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
                  <Text style={styles.quadrantTitle}>{quadrant.title}</Text>
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
                            {t.pendingSync}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        testID={`delete-task-${item.id}`}
                        onPress={() => onDelete(item.id)}
                        style={styles.deleteButton}
                      >
                        <Text style={styles.deleteButtonText}>{t.delete}</Text>
                      </Pressable>
                    </View>
                    <View style={styles.badges}>
                      <Pressable
                        testID={`toggle-urgent-${item.id}`}
                        onPress={() => onToggle(item.id, 'urgent')}
                        style={styles.badge}
                      >
                        <Text style={styles.badgeText}>{t.urgent}: {item.urgent ? t.on : t.off}</Text>
                      </Pressable>
                      <Pressable
                        testID={`toggle-important-${item.id}`}
                        onPress={() => onToggle(item.id, 'important')}
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
