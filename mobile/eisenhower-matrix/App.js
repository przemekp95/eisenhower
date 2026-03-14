import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import AIStatusPanel from './src/components/AIStatusPanel';
import LanguageSwitcher from './src/components/LanguageSwitcher';
import MatrixBoard from './src/components/MatrixBoard';
import TaskComposer from './src/components/TaskComposer';
import AIToolsModal from './src/components/ai/AIToolsModal';
import useTaskSyncController from './src/hooks/useTaskSyncController';
import {
  addTrainingExample,
  analyzeTaskAdvanced,
  batchAnalyzeTasks,
  clearTrainingData,
  fetchTrainingStats,
  getExamplesByQuadrant,
  learnFromFeedback,
  retrainModel,
  setAIProviderEnabled,
} from './src/services/ai';
import { scanTasksFromImage } from './src/services/media';
import { getSuggestedQuadrant, resolveOCRNotice } from './src/utils/aiUi';
import styles from './src/styles/appStyles';

export default function App() {
  const {
    addAnalysisTaskToMatrix,
    aiCapabilities,
    aiConnected,
    aiLoading,
    groupedTasks,
    handleAddTask,
    handleDelete,
    handleLanguageChange,
    handleScan,
    handleSuggest,
    handleToggle,
    importScannedTasks,
    language,
    loading,
    newTask,
    notice,
    providerControls,
    quadrantOptions,
    refreshCapabilities,
    scanDisabled,
    suggestDisabled,
    t,
    updateNewTaskField: updateTaskDraftField,
  } = useTaskSyncController();
  const [trainingStats, setTrainingStats] = useState(null);
  const [providerBusy, setProviderBusy] = useState({
    local_model: false,
    tesseract: false,
  });
  const [aiToolsOpen, setAiToolsOpen] = useState(false);
  const [activeAITab, setActiveAITab] = useState('analysis');
  const [aiToolsError, setAiToolsError] = useState('');
  const [aiToolsMessage, setAiToolsMessage] = useState('');
  const [analysisTask, setAnalysisTask] = useState('');
  const [advancedAnalysis, setAdvancedAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisAdding, setAnalysisAdding] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);
  const [batchInput, setBatchInput] = useState('');
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageAction, setManageAction] = useState('');
  const [exampleText, setExampleText] = useState('');
  const [exampleQuadrant, setExampleQuadrant] = useState(2);
  const [feedbackTask, setFeedbackTask] = useState('');
  const [predictedQuadrant, setPredictedQuadrant] = useState(1);
  const [correctQuadrant, setCorrectQuadrant] = useState(0);
  const [examplesQuadrant, setExamplesQuadrant] = useState(0);
  const [examples, setExamples] = useState([]);
  const [preserveExperience, setPreserveExperience] = useState(true);
  const [keepDefaults, setKeepDefaults] = useState(true);

  useEffect(() => {
    if (!aiToolsOpen) {
      return;
    }

    setAnalysisTask((current) => current || newTask.title);
  }, [aiToolsOpen, newTask.title]);

  useEffect(() => {
    if (aiToolsOpen && activeAITab === 'manage') {
      void refreshAIManagement();
    }
  }, [aiToolsOpen, activeAITab]);

  const refreshAIManagement = async () => {
    setManageLoading(true);

    try {
      const [stats] = await Promise.all([fetchTrainingStats(), refreshCapabilities()]);
      setTrainingStats(stats);
    } catch {
      setAiToolsError(t.aiManageLoadFailed);
    } finally {
      setManageLoading(false);
    }
  };

  const resetAIToolFeedback = () => {
    setAiToolsError('');
    setAiToolsMessage('');
  };

  const openAITools = (tab = 'analysis') => {
    resetAIToolFeedback();
    setAiToolsOpen(true);
    setActiveAITab(tab);
    setAnalysisTask(newTask.title);
  };

  const closeAITools = () => {
    setAiToolsOpen(false);
    resetAIToolFeedback();
  };

  const handleRunAdvancedAnalysis = async () => {
    if (!analysisTask.trim()) {
      setAiToolsError(t.aiAnalysisValidation);
      return;
    }

    setAnalysisLoading(true);
    resetAIToolFeedback();

    try {
      setAdvancedAnalysis(await analyzeTaskAdvanced(analysisTask.trim(), language));
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.aiAnalysisFailed);
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleAddAdvancedAnalysisToMatrix = async () => {
    if (!advancedAnalysis) {
      return;
    }

    setAnalysisAdding(true);
    resetAIToolFeedback();

    try {
      await addAnalysisTaskToMatrix(advancedAnalysis);
      setAiToolsMessage(t.aiAnalysisAdded);
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.aiAnalysisAddFailed);
    } finally {
      setAnalysisAdding(false);
    }
  };

  const handleOcrFromTools = async () => {
    setOcrLoading(true);
    resetAIToolFeedback();

    try {
      const scanned = await scanTasksFromImage(language);
      if (scanned.length === 0) {
        setOcrResult({ count: 0, items: [] });
        setAiToolsMessage(t.ocrEmpty);
        return;
      }

      const importedCount = await importScannedTasks(scanned);
      setOcrResult({ count: importedCount, items: scanned });
      setAiToolsMessage(t.aiOcrImported.replace('{count}', String(importedCount)));
    } catch (error) {
      setAiToolsError(resolveOCRNotice(error, t));
    } finally {
      setOcrLoading(false);
    }
  };

  const handleBatchAnalyze = async () => {
    const entries = batchInput
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (entries.length === 0) {
      setAiToolsError(t.aiBatchValidation);
      return;
    }

    setBatchLoading(true);
    resetAIToolFeedback();

    try {
      const result = await batchAnalyzeTasks(entries);
      setBatchResult(result);
      setAiToolsMessage(t.aiBatchComplete.replace('{count}', String(result.summary.total_tasks)));
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.aiBatchFailed);
    } finally {
      setBatchLoading(false);
    }
  };

  const runManageAction = async (actionKey, action, successMessage, afterSuccess = null) => {
    setManageAction(actionKey);
    resetAIToolFeedback();

    try {
      const result = await action();
      await refreshAIManagement();
      if (afterSuccess) {
        afterSuccess(result);
      }
      setAiToolsMessage(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.aiManageActionFailed);
    } finally {
      setManageAction('');
    }
  };

  const handleManageProviderToggle = async (providerName) => {
    const currentState = aiCapabilities?.provider_controls?.[providerName];
    if (!currentState) {
      return;
    }

    setProviderBusy((current) => ({ ...current, [providerName]: true }));

    try {
      await setAIProviderEnabled(providerName, !currentState.enabled);
      await refreshAIManagement();
      setAiToolsMessage(t.aiProviderToggleSaved);
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.aiProviderToggleFailed);
    } finally {
      setProviderBusy((current) => ({ ...current, [providerName]: false }));
    }
  };

  const handleTabChange = (tab) => {
    resetAIToolFeedback();
    setActiveAITab(tab);
  };

  const handleAddExample = () =>
    runManageAction(
      'add-example',
      () => addTrainingExample(exampleText.trim(), exampleQuadrant),
      t.aiManageExampleAdded,
      () => setExampleText('')
    );

  const handleLearnFeedback = () =>
    runManageAction(
      'feedback',
      () => learnFromFeedback(feedbackTask.trim(), predictedQuadrant, correctQuadrant),
      t.aiManageFeedbackSaved,
      () => setFeedbackTask('')
    );

  const handleRetrain = () =>
    runManageAction(
      'retrain',
      () => retrainModel(preserveExperience),
      t.aiManageRetrained
    );

  const handleClear = () =>
    runManageAction(
      'clear',
      () => clearTrainingData(keepDefaults),
      t.aiManageCleared,
      () => setExamples([])
    );

  const handleLoadExamples = () =>
    runManageAction(
      'examples',
      async () => {
        const response = await getExamplesByQuadrant(examplesQuadrant, 5);
        setExamples(response.examples || []);
        return response;
      },
      (response) => t.aiManageExamplesLoaded.replace('{count}', String(response?.examples?.length ?? 0))
    );

  if (loading) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.loading}>{t.loading}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{t.title}</Text>
            <Text style={styles.subtitle}>{t.subtitle}</Text>
          </View>
          <LanguageSwitcher language={language} onChange={handleLanguageChange} />
        </View>

        {notice ? (
          <View style={styles.notice}>
            <Text testID="notice-banner" style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <TaskComposer
          newTask={newTask}
          onChangeTask={updateTaskDraftField}
          onAddTask={handleAddTask}
          onSuggest={handleSuggest}
          onScan={handleScan}
          onOpenAITools={() => openAITools('analysis')}
          suggestDisabled={suggestDisabled}
          scanDisabled={scanDisabled}
          t={t}
        />

        <AIStatusPanel
          aiLoading={aiLoading}
          aiConnected={aiConnected}
          providerControls={providerControls}
          t={t}
        />

        <MatrixBoard
          quadrantOptions={quadrantOptions}
          groupedTasks={groupedTasks}
          onDelete={handleDelete}
          onToggle={handleToggle}
          t={t}
        />
      </ScrollView>

      <AIToolsModal
        visible={aiToolsOpen}
        t={t}
        activeTab={activeAITab}
        onTabChange={handleTabChange}
        onClose={closeAITools}
        quadrantOptions={quadrantOptions}
        analysisTask={analysisTask}
        onChangeAnalysisTask={setAnalysisTask}
        onRunAdvancedAnalysis={handleRunAdvancedAnalysis}
        analysisLoading={analysisLoading}
        advancedAnalysis={advancedAnalysis}
        suggestedQuadrant={advancedAnalysis ? getSuggestedQuadrant(advancedAnalysis) : 3}
        onAddAdvancedAnalysisToMatrix={handleAddAdvancedAnalysisToMatrix}
        analysisAdding={analysisAdding}
        onRunOcr={handleOcrFromTools}
        ocrLoading={ocrLoading}
        ocrResult={ocrResult}
        batchInput={batchInput}
        onChangeBatchInput={setBatchInput}
        onRunBatchAnalyze={handleBatchAnalyze}
        batchLoading={batchLoading}
        batchResult={batchResult}
        manageLoading={manageLoading}
        trainingStats={trainingStats}
        providerControls={providerControls}
        providerBusy={providerBusy}
        onToggleProvider={handleManageProviderToggle}
        exampleText={exampleText}
        onChangeExampleText={setExampleText}
        exampleQuadrant={exampleQuadrant}
        onSelectExampleQuadrant={setExampleQuadrant}
        onAddExample={handleAddExample}
        feedbackTask={feedbackTask}
        onChangeFeedbackTask={setFeedbackTask}
        predictedQuadrant={predictedQuadrant}
        onSelectPredictedQuadrant={setPredictedQuadrant}
        correctQuadrant={correctQuadrant}
        onSelectCorrectQuadrant={setCorrectQuadrant}
        onLearnFeedback={handleLearnFeedback}
        preserveExperience={preserveExperience}
        onChangePreserveExperience={setPreserveExperience}
        keepDefaults={keepDefaults}
        onChangeKeepDefaults={setKeepDefaults}
        onRetrain={handleRetrain}
        onClear={handleClear}
        examplesQuadrant={examplesQuadrant}
        onSelectExamplesQuadrant={setExamplesQuadrant}
        onLoadExamples={handleLoadExamples}
        examples={examples}
        aiToolsError={aiToolsError}
        aiToolsMessage={aiToolsMessage}
        manageAction={manageAction}
      />
    </SafeAreaView>
  );
}
