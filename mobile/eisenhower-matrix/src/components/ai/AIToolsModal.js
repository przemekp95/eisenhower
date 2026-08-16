import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styles from '../../styles/appStyles';
import {
  AI_TABS,
  getQuadrantTitleByValue,
} from '../../utils/aiUi';

export default function AIToolsModal({
  visible,
  t,
  availableTabs,
  activeTab,
  onTabChange,
  onClose,
  quadrantOptions,
  analysisTask,
  onChangeAnalysisTask,
  onRunAdvancedAnalysis,
  analysisLoading,
  advancedAnalysis,
  suggestedQuadrant,
  onAddAdvancedAnalysisToMatrix,
  analysisAdding,
  onRunOcr,
  ocrLoading,
  ocrResult,
  onChangeOcrItem,
  onImportOcr,
  batchInput,
  onChangeBatchInput,
  onRunBatchAnalyze,
  batchLoading,
  batchResult,
  aiToolsError,
  aiToolsMessage,
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <SafeAreaView style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View style={styles.modalHeaderCopy}>
              <Text style={styles.modalTitle}>{t.aiTools}</Text>
              <Text style={styles.modalSubtitle}>{t.aiToolsSubtitle}</Text>
            </View>
            <Pressable testID="ai-tools-close-top-button" accessibilityRole="button" onPress={onClose} style={styles.modalCloseButton}>
              <Text style={styles.modalCloseText}>{t.aiModalClose}</Text>
            </Pressable>
          </View>

          <View style={styles.tabRow}>
            {AI_TABS.filter((tab) => availableTabs.includes(tab)).map((tab) => (
              <Pressable
                key={tab}
                testID={`ai-tab-${tab}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === tab }}
                onPress={() => onTabChange(tab)}
                style={[styles.tabButton, activeTab === tab && styles.activeTabButton]}
              >
                <Text style={[styles.tabButtonText, activeTab === tab && styles.activeTabButtonText]}>
                  {t[`aiTab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`]}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView contentContainerStyle={styles.modalContent}>
            {availableTabs.length === 0 ? (
              <Text testID="ai-tools-unavailable" accessibilityRole="alert" style={styles.modalError}>{t.aiToolsUnavailable}</Text>
            ) : null}

            {availableTabs.includes('analysis') && activeTab === 'analysis' ? (
              <View style={styles.toolCard}>
                <Text style={styles.toolTitle}>{t.aiAnalysisTitle}</Text>
                <TextInput
                  testID="ai-analysis-input"
                  value={analysisTask}
                  onChangeText={onChangeAnalysisTask}
                  placeholder={t.aiAnalysisPlaceholder}
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                  multiline
                />
                <Pressable
                  testID="ai-analysis-run-button"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: analysisLoading }}
                  onPress={onRunAdvancedAnalysis}
                  disabled={analysisLoading}
                  style={[styles.primaryButton, analysisLoading && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>
                    {analysisLoading ? t.aiAnalysisRunning : t.aiAnalysisRun}
                  </Text>
                </Pressable>
                {advancedAnalysis ? (
                  <View style={styles.analysisResult}>
                    <Text testID="ai-analysis-reasoning" style={styles.analysisText}>
                      {advancedAnalysis.langchain_analysis.reasoning}
                    </Text>
                    <Text testID="ai-analysis-suggested" style={styles.analysisMeta}>
                      {t.aiAnalysisSuggested.replace(
                        '{quadrant}',
                        getQuadrantTitleByValue(quadrantOptions, suggestedQuadrant, t.quadrantEliminate)
                      )}
                    </Text>
                    <Pressable
                      testID="ai-analysis-add-button"
                      onPress={onAddAdvancedAnalysisToMatrix}
                      disabled={analysisAdding}
                      style={[styles.toolsButton, analysisAdding && styles.disabledButton]}
                    >
                      <Text style={styles.toolsButtonText}>
                        {analysisAdding ? t.aiAnalysisAdding : t.aiAnalysisAdd}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

            {availableTabs.includes('ocr') && activeTab === 'ocr' ? (
              <View style={styles.toolCard}>
                <Text style={styles.toolTitle}>{t.aiOcrTitle}</Text>
                <Pressable
                  testID="ai-ocr-run-button"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: ocrLoading }}
                  onPress={onRunOcr}
                  disabled={ocrLoading}
                  style={[styles.primaryButton, ocrLoading && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>
                    {ocrLoading ? t.aiOcrRunning : t.aiOcrRun}
                  </Text>
                </Pressable>
                {ocrResult ? (
                  <View style={styles.analysisResult}>
                    <Text accessibilityRole="header" style={styles.analysisMeta}>{t.aiOcrReviewTitle}</Text>
                    {ocrResult.items.map((item) => (
                      <View key={item.id} style={styles.toolCard}>
                        <View style={styles.switchRow}>
                          <Text style={styles.switchLabel}>{t.aiOcrInclude}</Text>
                          <Switch
                            testID={`ocr-selected-${item.id}`}
                            accessibilityLabel={`${t.aiOcrInclude}: ${item.title}`}
                            value={item.selected}
                            onValueChange={(selected) => onChangeOcrItem(item.id, { selected })}
                          />
                        </View>
                        <TextInput
                          testID={`ocr-title-${item.id}`}
                          accessibilityLabel={t.titlePlaceholder}
                          value={item.title}
                          onChangeText={(title) => onChangeOcrItem(item.id, { title })}
                          style={styles.input}
                        />
                        <View accessibilityRole="radiogroup" style={styles.chipRow}>
                          {quadrantOptions.map((quadrant) => (
                            <Pressable
                              key={`${item.id}-${quadrant.value}`}
                              testID={`ocr-quadrant-${item.id}-${quadrant.value}`}
                              accessibilityRole="radio"
                              accessibilityState={{ checked: item.quadrant === quadrant.value }}
                              accessibilityLabel={`${t.aiOcrQuadrant}: ${quadrant.title}`}
                              onPress={() => onChangeOcrItem(item.id, { quadrant: quadrant.value })}
                              style={[styles.chip, item.quadrant === quadrant.value && styles.chipActive]}
                            >
                              <Text style={[styles.chipText, item.quadrant === quadrant.value && styles.chipTextActive]}>
                                {quadrant.title}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ))}
                    <Pressable
                      testID="ocr-import-button"
                      accessibilityRole="button"
                      onPress={onImportOcr}
                      disabled={ocrLoading || !ocrResult.items.some((item) => item.selected && item.title.trim())}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>{t.aiOcrImportReviewed}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

            {availableTabs.includes('batch') && activeTab === 'batch' ? (
              <View style={styles.toolCard}>
                <Text style={styles.toolTitle}>{t.aiBatchTitle}</Text>
                <TextInput
                  testID="ai-batch-input"
                  value={batchInput}
                  onChangeText={onChangeBatchInput}
                  placeholder={t.aiBatchPlaceholder}
                  placeholderTextColor="#94a3b8"
                  style={[styles.input, styles.batchInput]}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  testID="ai-batch-run-button"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: batchLoading }}
                  onPress={onRunBatchAnalyze}
                  disabled={batchLoading}
                  style={[styles.primaryButton, batchLoading && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>
                    {batchLoading ? t.aiBatchRunning : t.aiBatchRun}
                  </Text>
                </Pressable>
                {batchResult ? (
                  <View style={styles.batchResults}>
                    {batchResult.batch_results.map((entry) => (
                      <View key={entry.task} style={styles.batchResultItem}>
                        <Text style={styles.batchTask}>{entry.task}</Text>
                        <Text style={styles.batchQuadrant}>
                          {getQuadrantTitleByValue(
                            quadrantOptions,
                            entry.analyses.rag.quadrant,
                            t.quadrantEliminate
                          )}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}


            {aiToolsError ? <Text testID="ai-tools-error" style={styles.modalError}>{aiToolsError}</Text> : null}
            {aiToolsMessage ? <Text testID="ai-tools-message" style={styles.modalMessage}>{aiToolsMessage}</Text> : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable
              testID="ai-tools-close-button"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.modalFooterCloseButton}
            >
              <Text style={styles.modalFooterCloseText}>{t.aiModalClose}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
