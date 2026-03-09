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
  getProviderLabel,
  getProviderStatus,
  getProviderTone,
  getQuadrantTitleByValue,
} from '../../utils/aiUi';

export default function AIToolsModal({
  visible,
  t,
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
  batchInput,
  onChangeBatchInput,
  onRunBatchAnalyze,
  batchLoading,
  batchResult,
  manageLoading,
  trainingStats,
  providerControls,
  providerBusy,
  onToggleProvider,
  exampleText,
  onChangeExampleText,
  exampleQuadrant,
  onSelectExampleQuadrant,
  onAddExample,
  feedbackTask,
  onChangeFeedbackTask,
  predictedQuadrant,
  onSelectPredictedQuadrant,
  correctQuadrant,
  onSelectCorrectQuadrant,
  onLearnFeedback,
  preserveExperience,
  onChangePreserveExperience,
  keepDefaults,
  onChangeKeepDefaults,
  onRetrain,
  onClear,
  examplesQuadrant,
  onSelectExamplesQuadrant,
  onLoadExamples,
  examples,
  aiToolsError,
  aiToolsMessage,
  manageAction,
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
            <Pressable testID="ai-tools-close-top-button" onPress={onClose} style={styles.modalCloseButton}>
              <Text style={styles.modalCloseText}>{t.aiModalClose}</Text>
            </Pressable>
          </View>

          <View style={styles.tabRow}>
            {AI_TABS.map((tab) => (
              <Pressable
                key={tab}
                testID={`ai-tab-${tab}`}
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
            {activeTab === 'analysis' ? (
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

            {activeTab === 'ocr' ? (
              <View style={styles.toolCard}>
                <Text style={styles.toolTitle}>{t.aiOcrTitle}</Text>
                <Pressable
                  testID="ai-ocr-run-button"
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
                    <Text style={styles.analysisMeta}>
                      {t.aiOcrImported.replace('{count}', String(ocrResult.count))}
                    </Text>
                    {ocrResult.items.map((item) => (
                      <Text key={item.id} style={styles.exampleItemText}>
                        {item.title}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {activeTab === 'batch' ? (
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

            {activeTab === 'manage' ? (
              <View style={styles.manageStack}>
                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageTrainingState}</Text>
                  {manageLoading ? (
                    <Text style={styles.manageHint}>{t.loading}</Text>
                  ) : (
                    <View style={styles.manageStatBlock}>
                      <Text style={styles.manageBigNumber}>{trainingStats?.total_examples ?? 0}</Text>
                      <Text style={styles.manageHint}>
                        {t.aiPanelExamples}: {trainingStats?.total_examples ?? 0}
                      </Text>
                      {trainingStats?.model_name ? (
                        <Text style={styles.manageHint}>
                          {trainingStats.model_name} (
                          {trainingStats.model_ready ? t.aiProviderStatusActive : t.aiProviderStatusUnavailable}
                          )
                        </Text>
                      ) : null}
                      {trainingStats?.model_encoder ? (
                        <Text style={styles.manageMuted}>{trainingStats.model_encoder}</Text>
                      ) : null}
                    </View>
                  )}
                </View>

                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageProviders}</Text>
                  {['local_model', 'tesseract'].map((providerName) => {
                    const control = providerControls[providerName];

                    return (
                      <View key={providerName} style={styles.providerRow}>
                        <View style={styles.providerCopy}>
                          <Text style={styles.providerTitle}>{getProviderLabel(providerName, t)}</Text>
                          <Text style={[styles.providerStatus, { color: getProviderTone(control) }]}>
                            {getProviderStatus(control, t)}
                          </Text>
                        </View>
                        <Switch
                          testID={`modal-provider-switch-${providerName}`}
                          value={Boolean(control?.enabled)}
                          disabled={!control || providerBusy[providerName]}
                          onValueChange={() => onToggleProvider(providerName)}
                        />
                      </View>
                    );
                  })}
                </View>

                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageAddExample}</Text>
                  <TextInput
                    testID="manage-example-input"
                    value={exampleText}
                    onChangeText={onChangeExampleText}
                    placeholder={t.aiManageExamplePlaceholder}
                    placeholderTextColor="#94a3b8"
                    style={styles.input}
                  />
                  <View style={styles.chipRow}>
                    {quadrantOptions.map((quadrant) => (
                      <Pressable
                        key={`example-${quadrant.value}`}
                        testID={`manage-example-quadrant-${quadrant.value}`}
                        onPress={() => onSelectExampleQuadrant(quadrant.value)}
                        style={[
                          styles.chip,
                          exampleQuadrant === quadrant.value && styles.chipActive,
                        ]}
                      >
                        <Text style={[styles.chipText, exampleQuadrant === quadrant.value && styles.chipTextActive]}>
                          {quadrant.title}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Pressable
                    testID="manage-add-example-button"
                    onPress={onAddExample}
                    disabled={manageAction !== '' || exampleText.trim().length === 0}
                    style={[
                      styles.primaryButton,
                      (manageAction !== '' || exampleText.trim().length === 0) && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>{t.aiManageAddExampleButton}</Text>
                  </Pressable>
                </View>

                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageFeedback}</Text>
                  <TextInput
                    testID="manage-feedback-input"
                    value={feedbackTask}
                    onChangeText={onChangeFeedbackTask}
                    placeholder={t.aiManageFeedbackPlaceholder}
                    placeholderTextColor="#94a3b8"
                    style={styles.input}
                  />
                  <Text style={styles.manageHint}>{t.aiManagePredicted}</Text>
                  <View style={styles.chipRow}>
                    {quadrantOptions.map((quadrant) => (
                      <Pressable
                        key={`predicted-${quadrant.value}`}
                        testID={`manage-predicted-quadrant-${quadrant.value}`}
                        onPress={() => onSelectPredictedQuadrant(quadrant.value)}
                        style={[
                          styles.chip,
                          predictedQuadrant === quadrant.value && styles.chipActive,
                        ]}
                      >
                        <Text style={[styles.chipText, predictedQuadrant === quadrant.value && styles.chipTextActive]}>
                          {quadrant.title}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.manageHint}>{t.aiManageCorrect}</Text>
                  <View style={styles.chipRow}>
                    {quadrantOptions.map((quadrant) => (
                      <Pressable
                        key={`correct-${quadrant.value}`}
                        testID={`manage-correct-quadrant-${quadrant.value}`}
                        onPress={() => onSelectCorrectQuadrant(quadrant.value)}
                        style={[
                          styles.chip,
                          correctQuadrant === quadrant.value && styles.chipActive,
                        ]}
                      >
                        <Text style={[styles.chipText, correctQuadrant === quadrant.value && styles.chipTextActive]}>
                          {quadrant.title}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Pressable
                    testID="manage-feedback-button"
                    onPress={onLearnFeedback}
                    disabled={manageAction !== '' || feedbackTask.trim().length === 0}
                    style={[
                      styles.primaryButton,
                      (manageAction !== '' || feedbackTask.trim().length === 0) && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>{t.aiManageFeedbackButton}</Text>
                  </Pressable>
                </View>

                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageMaintenance}</Text>
                  <View style={styles.switchRow}>
                    <Text style={styles.switchLabel}>{t.aiManagePreserveExperience}</Text>
                    <Switch
                      testID="manage-preserve-experience-switch"
                      value={preserveExperience}
                      onValueChange={onChangePreserveExperience}
                    />
                  </View>
                  <View style={styles.switchRow}>
                    <Text style={styles.switchLabel}>{t.aiManageKeepDefaults}</Text>
                    <Switch
                      testID="manage-keep-defaults-switch"
                      value={keepDefaults}
                      onValueChange={onChangeKeepDefaults}
                    />
                  </View>
                  <View style={styles.actions}>
                    <Pressable
                      testID="manage-retrain-button"
                      onPress={onRetrain}
                      disabled={manageAction !== ''}
                      style={[styles.toolsButton, manageAction !== '' && styles.disabledButton]}
                    >
                      <Text style={styles.toolsButtonText}>{t.aiManageRetrainButton}</Text>
                    </Pressable>
                    <Pressable
                      testID="manage-clear-button"
                      onPress={onClear}
                      disabled={manageAction !== ''}
                      style={[styles.secondaryButton, manageAction !== '' && styles.disabledButton]}
                    >
                      <Text style={styles.secondaryButtonText}>{t.aiManageClearButton}</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.toolCard}>
                  <Text style={styles.toolTitle}>{t.aiManageBrowseExamples}</Text>
                  <View style={styles.chipRow}>
                    {quadrantOptions.map((quadrant) => (
                      <Pressable
                        key={`browse-${quadrant.value}`}
                        testID={`manage-browse-quadrant-${quadrant.value}`}
                        onPress={() => onSelectExamplesQuadrant(quadrant.value)}
                        style={[
                          styles.chip,
                          examplesQuadrant === quadrant.value && styles.chipActive,
                        ]}
                      >
                        <Text style={[styles.chipText, examplesQuadrant === quadrant.value && styles.chipTextActive]}>
                          {quadrant.title}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Pressable
                    testID="manage-load-examples-button"
                    onPress={onLoadExamples}
                    disabled={manageAction !== ''}
                    style={[styles.primaryButton, manageAction !== '' && styles.disabledButton]}
                  >
                    <Text style={styles.primaryButtonText}>{t.aiManageLoadExamplesButton}</Text>
                  </Pressable>
                  <View style={styles.examplesList}>
                    {examples.length > 0 ? (
                      examples.map((example, index) => (
                        <View key={`${example.text}-${index}`} style={styles.exampleItem}>
                          <Text style={styles.exampleItemText}>{example.text}</Text>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.emptyQuadrantText}>{t.aiManageExamplesEmpty}</Text>
                    )}
                  </View>
                </View>
              </View>
            ) : null}

            {aiToolsError ? <Text testID="ai-tools-error" style={styles.modalError}>{aiToolsError}</Text> : null}
            {aiToolsMessage ? <Text testID="ai-tools-message" style={styles.modalMessage}>{aiToolsMessage}</Text> : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable
              testID="ai-tools-close-button"
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
