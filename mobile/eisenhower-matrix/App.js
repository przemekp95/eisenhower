import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Network from 'expo-network';
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
import { flagsToQuadrant, quadrantToFlags } from './src/utils/taskUtils';
import styles from './src/styles/appStyles';
import {
  clearAdminToken,
  clearApiToken,
  getAdminToken,
  getApiToken,
  setAdminToken,
  setApiToken,
  subscribeToApiToken,
} from './src/authSession';

function AuthenticatedApp() {
  const {
    addAnalysisTaskToMatrix,
    aiCapabilities,
    aiConnected,
    aiLoading,
    groupedTasks,
    handleAddTask,
    handleDelete,
    handleDelegation,
    handleDelegationStatus,
    handleDelegatedResolveConflict,
    handleLanguageChange,
    handleLifecycle,
    handleResolveConflict,
    handleSchedule,
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
    retrySync,
    scanDisabled,
    suggestDisabled,
    taskView,
    setTaskView,
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
  const [adminAuthenticated, setAdminAuthenticated] = useState(Boolean(getAdminToken()));
  const [adminTokenInput, setAdminTokenInput] = useState('');
  const [ocrLearningConsent, setOcrLearningConsent] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const retrySyncRef = useRef(retrySync);
  const networkReachableRef = useRef(null);

  useEffect(() => {
    retrySyncRef.current = retrySync;
  }, [retrySync]);

  useEffect(
    () => subscribeToApiToken(() => setAdminAuthenticated(Boolean(getAdminToken()))),
    []
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void retrySyncRef.current();
      }
    });
    return () => subscription?.remove?.();
  }, []);

  useEffect(() => {
    const subscription = Network.addNetworkStateListener((state) => {
      const reachable = state.isConnected === true && state.isInternetReachable !== false;
      const recovered = networkReachableRef.current === false && reachable;
      networkReachableRef.current = reachable;

      if (recovered) {
        void retrySyncRef.current();
      }
    });
    return () => subscription?.remove?.();
  }, []);

  useEffect(() => {
    if (!aiToolsOpen) {
      return;
    }

    setAnalysisTask((current) => current || newTask.title);
  }, [aiToolsOpen, newTask.title]);

  useEffect(() => {
    if (aiToolsOpen && activeAITab === 'manage' && adminAuthenticated) {
      void refreshAIManagement();
    }
  }, [aiToolsOpen, activeAITab, adminAuthenticated]);

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

      setOcrResult({
        items: scanned.map((item, index) => ({
          ...item,
          id: item.id || `ocr-review-${index}`,
          selected: true,
          quadrant: flagsToQuadrant(item),
        })),
      });
      setOcrLearningConsent(false);
      setAiToolsMessage(t.aiOcrReviewReady.replace('{count}', String(scanned.length)));
    } catch (error) {
      setAiToolsError(resolveOCRNotice(error, t));
    } finally {
      setOcrLoading(false);
    }
  };

  const handleChangeOcrItem = (id, patch) => {
    setOcrResult((current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === id ? { ...item, ...patch } : item),
    } : current);
  };

  const handleImportReviewedOcr = async () => {
    const selected = (ocrResult?.items || [])
      .filter((item) => item.selected && item.title.trim())
      .map((item) => ({ ...item, ...quadrantToFlags(item.quadrant) }));
    if (selected.length === 0) return;

    setOcrLoading(true);
    resetAIToolFeedback();
    try {
      const result = await importScannedTasks(selected, { learn: ocrLearningConsent });
      setAiToolsMessage(
        t.aiOcrImportResult
          .replace('{imported}', String(result.imported))
          .replace('{saved}', String(result.savedRemotely))
          .replace('{pending}', String(result.pending))
          .replace('{feedback}', ocrLearningConsent ? (result.feedbackSaved ? t.yes : t.no) : t.notRequested)
      );
      setOcrResult(null);
      setOcrLearningConsent(false);
    } catch (error) {
      setAiToolsError(error instanceof Error ? error.message : t.ocrFailed);
    } finally {
      setOcrLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await retrySync();
    } finally {
      setRefreshing(false);
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
      () => {
        setExamples([]);
        setClearConfirmationOpen(false);
      }
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
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{t.title}</Text>
            <Text style={styles.subtitle}>{t.subtitle}</Text>
          </View>
          <LanguageSwitcher language={language} onChange={handleLanguageChange} />
          <View style={styles.actions}>
            <Pressable testID="retry-sync-button" accessibilityRole="button" onPress={handleRefresh} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{t.retrySync}</Text>
            </Pressable>
            <Pressable testID="logout-button" accessibilityRole="button" onPress={clearApiToken} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{t.logout}</Text>
            </Pressable>
          </View>
        </View>

        {notice ? (
          <View style={styles.notice}>
            <Text testID="notice-banner" style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <View accessibilityRole="tablist" style={styles.actions}>
          <Pressable
            testID="task-view-owned"
            accessibilityRole="tab"
            accessibilityState={{ selected: taskView === 'owned' }}
            onPress={() => setTaskView('owned')}
            style={taskView === 'owned' ? styles.primaryButton : styles.secondaryButton}
          >
            <Text style={taskView === 'owned' ? styles.primaryButtonText : styles.secondaryButtonText}>{t.taskViewOwned}</Text>
          </Pressable>
          <Pressable
            testID="task-view-delegated"
            accessibilityRole="tab"
            accessibilityState={{ selected: taskView === 'delegated' }}
            onPress={() => setTaskView('delegated')}
            style={taskView === 'delegated' ? styles.primaryButton : styles.secondaryButton}
          >
            <Text style={taskView === 'delegated' ? styles.primaryButtonText : styles.secondaryButtonText}>{t.taskViewDelegated}</Text>
          </Pressable>
        </View>

        {taskView === 'owned' ? <TaskComposer
          newTask={newTask}
          onChangeTask={updateTaskDraftField}
          onAddTask={handleAddTask}
          onSuggest={handleSuggest}
          onScan={() => {
            openAITools('ocr');
            void handleOcrFromTools();
          }}
          onOpenAITools={() => openAITools('analysis')}
          suggestDisabled={suggestDisabled}
          scanDisabled={scanDisabled}
          t={t}
        /> : null}

        {taskView === 'owned' ? <AIStatusPanel
          aiLoading={aiLoading}
          aiConnected={aiConnected}
          providerControls={providerControls}
          t={t}
        /> : null}

        <MatrixBoard
          quadrantOptions={quadrantOptions}
          groupedTasks={groupedTasks}
          onDelete={handleDelete}
          onLifecycle={handleLifecycle}
          onResolveConflict={taskView === 'delegated' ? handleDelegatedResolveConflict : handleResolveConflict}
          onSchedule={handleSchedule}
          onClearSchedule={(id) => handleSchedule(id, null)}
          onDelegation={handleDelegation}
          onDelegationStatus={handleDelegationStatus}
          taskView={taskView}
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
        onChangeOcrItem={handleChangeOcrItem}
        onImportOcr={handleImportReviewedOcr}
        ocrLearningConsent={ocrLearningConsent}
        onChangeOcrLearningConsent={setOcrLearningConsent}
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
        adminAuthenticated={adminAuthenticated}
        adminTokenInput={adminTokenInput}
        onChangeAdminTokenInput={setAdminTokenInput}
        onSubmitAdminToken={() => {
          setAdminToken(adminTokenInput);
          setAdminTokenInput('');
          setAdminAuthenticated(true);
        }}
        onClearAdminToken={() => {
          clearAdminToken();
          setAdminAuthenticated(false);
        }}
        clearConfirmationOpen={clearConfirmationOpen}
        onRequestClear={() => setClearConfirmationOpen(true)}
        onCancelClear={() => setClearConfirmationOpen(false)}
      />
    </SafeAreaView>
  );
}

function CredentialGate() {
  const [token, setToken] = useState('');

  return (
    <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#030816' }}>
      <View style={{ padding: 24, borderRadius: 24, backgroundColor: '#0f172a' }}>
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>Eisenhower Matrix</Text>
        <Text style={{ color: '#cbd5e1', marginTop: 12, lineHeight: 20 }}>
          Wpisz token dostępu. Token administratora podasz osobno tylko przy wejściu do panelu zarządzania AI.
        </Text>
        <TextInput
          testID="auth-token-input"
          accessibilityLabel="Token dostępu"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={token}
          onChangeText={setToken}
          style={{ marginTop: 20, borderRadius: 12, padding: 14, color: '#fff', backgroundColor: '#1e293b' }}
        />
        <Pressable
          testID="auth-submit-button"
          accessibilityRole="button"
          disabled={!token.trim()}
          onPress={() => {
            setApiToken(token);
            setToken('');
          }}
          style={{ marginTop: 16, borderRadius: 12, padding: 14, backgroundColor: '#67e8f9', opacity: token.trim() ? 1 : 0.4 }}
        >
          <Text style={{ textAlign: 'center', color: '#0f172a', fontWeight: '700' }}>Odblokuj</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [apiToken, setTokenState] = useState(getApiToken());

  useEffect(() => subscribeToApiToken(() => setTokenState(getApiToken())), []);

  return apiToken ? <AuthenticatedApp /> : <CredentialGate />;
}
