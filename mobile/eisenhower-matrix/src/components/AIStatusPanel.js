import React from 'react';
import { Text, View } from 'react-native';
import styles from '../styles/appStyles';

export default function AIStatusPanel({
  aiLoading,
  aiConnected,
  t,
}) {
  return (
    <View style={styles.aiSummary}>
      <Text style={styles.sectionEyebrow}>{t.aiPanelTitle}</Text>
      <Text style={styles.aiSubtitle}>{t.aiPanelSubtitle}</Text>
      <View style={[styles.aiStatusBadge, aiConnected ? styles.aiStatusOnline : styles.aiStatusOffline]}>
        <Text style={styles.aiStatusText}>
          {aiLoading ? t.loading : aiConnected ? t.aiPanelConnected : t.aiPanelOffline}
        </Text>
      </View>
    </View>
  );
}
