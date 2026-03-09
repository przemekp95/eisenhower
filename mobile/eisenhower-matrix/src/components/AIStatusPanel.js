import React from 'react';
import { Text, View } from 'react-native';
import styles from '../styles/appStyles';
import {
  getProviderLabel,
  getProviderStatus,
  getProviderTone,
} from '../utils/aiUi';

export default function AIStatusPanel({
  aiLoading,
  aiConnected,
  providerControls,
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
      <View style={styles.providerPills}>
        {['local_model', 'tesseract'].map((providerName) => {
          const control = providerControls[providerName];

          return (
            <View
              key={providerName}
              style={[
                styles.providerPill,
                { borderColor: `${getProviderTone(control)}66` },
              ]}
            >
              <Text style={styles.providerPillLabel}>{getProviderLabel(providerName, t)}</Text>
              <Text style={[styles.providerPillStatus, { color: getProviderTone(control) }]}>
                {getProviderStatus(control, t)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
