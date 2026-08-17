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
import { analyzeTaskAdvanced, answerKnowledge, batchAnalyzeTasks } from './src/services/ai';
import { extractTasksFromSelectedImage, selectImageForOcr } from './src/services/media';
import { getSuggestedQuadrant, resolveAIActionNotice, resolveOCRNotice } from './src/utils/aiUi';
import { flagsToQuadrant, quadrantToFlags } from './src/utils/taskUtils';
import styles from './src/styles/appStyles';
import { clearApiToken, getApiToken, setApiToken, subscribeToApiToken } from './src/authSession';

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
    handleSuggest,
    handleToggle,
    importScannedTasks,
    language,
    loading,
    newTask,
    notice,
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
  const [aiToolsOpen, setAiToolsOpen] = useState(false);
  const [activeAITab, setActiveAITab] = useState('analysis');
  const [aiToolsError, setAiToolsError] = useState('');
  const [aiToolsMessage, setAiToolsMessage] = useState('');
  const [analysisTask, setAnalysisTask] = useState('');
  const [advancedAnalysis, setAdvancedAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisAdding, setAnalysisAdding] = useState(false);
  const [groundedQuestion, setGroundedQuestion] = useState('');
  const [groundedLoading, setGroundedLoading] = useState(false);
  const [groundedResult, setGroundedResult] = useState(null);
  const [groundedDescriptionPreview, setGroundedDescriptionPreview] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrSelectedImage, setOcrSelectedImage] = useState(null);
  const [ocrResult, setOcrResult] = useState(null);
  const [batchInput, setBatchInput] = useState('');
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const retrySyncRef = useRef(retrySync);
  const refreshCapabilitiesRef = useRef(refreshCapabilities);
  const networkReachableRef = useRef(null);
  const analysisRequestRef = useRef(null);
  const groundedRequestRef = useRef(null);
  const batchRequestRef = useRef(null);
  const ocrRequestRef = useRef(null);
  const availableAITabs = [
    ...(aiCapabilities?.reasoned_local_analysis ? ['analysis'] : []),
    ...(aiCapabilities?.knowledge_retrieval ? ['grounded'] : []),
    ...(aiCapabilities?.ocr ? ['ocr'] : []),
    ...(aiCapabilities?.batch_analysis ? ['batch'] : []),
  ];

  useEffect(() => {
    retrySyncRef.current = retrySync;
    refreshCapabilitiesRef.current = refreshCapabilities;
  }, [refreshCapabilities, retrySync]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void retrySyncRef.current();
        void refreshCapabilitiesRef.current().catch(() => {});
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
        void refreshCapabilitiesRef.current().catch(() => {});
      }
    });
    return () => subscription?.remove?.();
  }, []);

  useEffect(() => () => {
    analysisRequestRef.current?.abort();
    groundedRequestRef.current?.abort();
    batchRequestRef.current?.abort();
    ocrRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!aiToolsOpen) {
      return;
    }

    setAnalysisTask((current) => current || newTask.title);
    setGroundedQuestion((current) => current || newTask.title);
  }, [aiToolsOpen, newTask.title]);

  const resetAIToolFeedback = () => {
    setAiToolsError('');
    setAiToolsMessage('');
  };

  const cancelAnalysisRequest = () => {
    analysisRequestRef.current?.abort();
    analysisRequestRef.current = null;
    setAnalysisLoading(false);
  };

  const cancelBatchRequest = () => {
    batchRequestRef.current?.abort();
    batchRequestRef.current = null;
    setBatchLoading(false);
  };

  const cancelGroundedRequest = () => {
    groundedRequestRef.current?.abort();
    groundedRequestRef.current = null;
    setGroundedLoading(false);
  };

  const cancelOcrRequest = () => {
    ocrRequestRef.current?.abort();
    ocrRequestRef.current = null;
    setOcrLoading(false);
  };

  const openAITools = (tab = 'analysis') => {
    resetAIToolFeedback();
    const nextTab = availableAITabs.includes(tab) ? tab : availableAITabs[0];
    if (!nextTab) return;
    setAiToolsOpen(true);
    setActiveAITab(nextTab);
    setAnalysisTask(newTask.title);
    setGroundedQuestion(newTask.title);
  };

  const closeAITools = () => {
    cancelAnalysisRequest();
    cancelGroundedRequest();
    cancelBatchRequest();
    cancelOcrRequest();
    setAdvancedAnalysis(null);
    setGroundedResult(null);
    setGroundedDescriptionPreview(null);
    setBatchResult(null);
    setOcrResult(null);
    setOcrSelectedImage(null);
    setAiToolsOpen(false);
    resetAIToolFeedback();
  };

  const handleRunAdvancedAnalysis = async () => {
    if (!analysisTask.trim()) {
      setAiToolsError(t.aiAnalysisValidation);
      return;
    }

    cancelAnalysisRequest();
    setAdvancedAnalysis(null);
    resetAIToolFeedback();
    const controller = new AbortController();
    analysisRequestRef.current = controller;
    setAnalysisLoading(true);

    try {
      const result = await analyzeTaskAdvanced(analysisTask.trim(), language, {
        signal: controller.signal,
      });
      if (analysisRequestRef.current === controller && !controller.signal.aborted) {
        setAdvancedAnalysis(result);
      }
    } catch (error) {
      if (analysisRequestRef.current === controller) {
        const message = resolveAIActionNotice(error, t, t.aiManualFallback);
        if (message) setAiToolsError(message);
      }
    } finally {
      if (analysisRequestRef.current === controller) {
        analysisRequestRef.current = null;
        setAnalysisLoading(false);
      }
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
      setAiToolsError(t.aiAnalysisAddFailed);
    } finally {
      setAnalysisAdding(false);
    }
  };

  const handleRunGrounded = async () => {
    if (!groundedQuestion.trim()) return;
    cancelGroundedRequest();
    setGroundedResult(null);
    setGroundedDescriptionPreview(null);
    resetAIToolFeedback();
    const controller = new AbortController();
    groundedRequestRef.current = controller;
    setGroundedLoading(true);
    try {
      const result = await answerKnowledge(groundedQuestion.trim(), language, {
        signal: controller.signal,
      });
      if (groundedRequestRef.current === controller && !controller.signal.aborted) {
        setGroundedResult(result);
      }
    } catch (error) {
      if (groundedRequestRef.current === controller) {
        const message = resolveAIActionNotice(error, t, t.aiGroundedFailed);
        if (message) setAiToolsError(message);
      }
    } finally {
      if (groundedRequestRef.current === controller) {
        groundedRequestRef.current = null;
        setGroundedLoading(false);
      }
    }
  };

  const handlePrepareGroundedDescription = (answer) => {
    const existing = newTask.description.trim();
    setGroundedDescriptionPreview(existing ? `${existing}\n\n${answer}` : answer);
  };

  const handleApplyGroundedDescription = () => {
    if (!groundedDescriptionPreview?.trim()) return;
    updateTaskDraftField('description', groundedDescriptionPreview.trim());
    setGroundedDescriptionPreview(null);
    setAiToolsMessage(t.aiGroundedApplied);
  };

  const handleSelectOcrImage = async (source) => {
    setOcrResult(null);
    resetAIToolFeedback();
    try {
      setOcrSelectedImage(await selectImageForOcr(source));
    } catch (error) {
      const message = resolveOCRNotice(error, t);
      if (message) setAiToolsError(message);
    }
  };

  const handleSubmitOcrImage = async () => {
    if (!ocrSelectedImage) return;
    cancelOcrRequest();
    setOcrResult(null);
    resetAIToolFeedback();
    const controller = new AbortController();
    ocrRequestRef.current = controller;
    setOcrLoading(true);
    try {
      const scanned = await extractTasksFromSelectedImage(
        ocrSelectedImage,
        language,
        { signal: controller.signal }
      );
      if (ocrRequestRef.current !== controller || controller.signal.aborted) {
        return;
      }
      if (scanned.length === 0) {
        setOcrResult({ count: 0, items: [] });
        setOcrSelectedImage(null);
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
      setOcrSelectedImage(null);
      setAiToolsMessage(t.aiOcrReviewReady.replace('{count}', String(scanned.length)));
    } catch (error) {
      if (ocrRequestRef.current === controller) {
        const message = resolveOCRNotice(error, t);
        if (message) setAiToolsError(message);
      }
    } finally {
      if (ocrRequestRef.current === controller) {
        ocrRequestRef.current = null;
        setOcrLoading(false);
      }
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
      const result = await importScannedTasks(selected);
      setAiToolsMessage(
        t.aiOcrImportResult
          .replace('{imported}', String(result.imported))
          .replace('{saved}', String(result.savedRemotely))
          .replace('{pending}', String(result.pending))
      );
      setOcrResult(null);
    } catch (error) {
      setAiToolsError(t.ocrFailed);
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

    cancelBatchRequest();
    setBatchResult(null);
    resetAIToolFeedback();
    const controller = new AbortController();
    batchRequestRef.current = controller;
    setBatchLoading(true);

    try {
      const result = await batchAnalyzeTasks(entries, { signal: controller.signal });
      if (batchRequestRef.current === controller && !controller.signal.aborted) {
        setBatchResult(result);
        setAiToolsMessage(t.aiBatchComplete.replace('{count}', String(result.summary.total_tasks)));
      }
    } catch (error) {
      if (batchRequestRef.current === controller) {
        const message = resolveAIActionNotice(error, t, t.aiManualFallback);
        if (message) setAiToolsError(message);
      }
    } finally {
      if (batchRequestRef.current === controller) {
        batchRequestRef.current = null;
        setBatchLoading(false);
      }
    }
  };

  const handleTabChange = (tab) => {
    if (!availableAITabs.includes(tab)) return;
    if (tab !== 'grounded') cancelGroundedRequest();
    resetAIToolFeedback();
    setActiveAITab(tab);
  };

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
          }}
          onOpenAITools={() => openAITools('analysis')}
          suggestDisabled={suggestDisabled}
          scanDisabled={scanDisabled}
          toolsDisabled={availableAITabs.length === 0}
          t={t}
        /> : null}

        {taskView === 'owned' ? <AIStatusPanel
          aiLoading={aiLoading}
          aiConnected={aiConnected}
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
        availableTabs={availableAITabs}
        activeTab={activeAITab}
        onTabChange={handleTabChange}
        onClose={closeAITools}
        quadrantOptions={quadrantOptions}
        analysisTask={analysisTask}
        onChangeAnalysisTask={(value) => {
          cancelAnalysisRequest();
          setAnalysisTask(value);
          setAdvancedAnalysis(null);
        }}
        onRunAdvancedAnalysis={handleRunAdvancedAnalysis}
        analysisLoading={analysisLoading}
        advancedAnalysis={advancedAnalysis}
        suggestedQuadrant={advancedAnalysis ? getSuggestedQuadrant(advancedAnalysis) : 3}
        onAddAdvancedAnalysisToMatrix={handleAddAdvancedAnalysisToMatrix}
        analysisAdding={analysisAdding}
        groundedQuestion={groundedQuestion}
        onChangeGroundedQuestion={(value) => {
          cancelGroundedRequest();
          setGroundedQuestion(value);
          setGroundedResult(null);
          setGroundedDescriptionPreview(null);
        }}
        onRunGrounded={handleRunGrounded}
        onCancelGrounded={cancelGroundedRequest}
        groundedLoading={groundedLoading}
        groundedResult={groundedResult}
        groundedDescriptionPreview={groundedDescriptionPreview}
        onPrepareGroundedDescription={handlePrepareGroundedDescription}
        onChangeGroundedDescriptionPreview={setGroundedDescriptionPreview}
        onApplyGroundedDescription={handleApplyGroundedDescription}
        onDiscardGroundedDescription={() => setGroundedDescriptionPreview(null)}
        onSelectOcrImage={handleSelectOcrImage}
        onSubmitOcrImage={handleSubmitOcrImage}
        onDiscardOcrImage={() => setOcrSelectedImage(null)}
        ocrSelectedImage={ocrSelectedImage}
        ocrLoading={ocrLoading}
        ocrResult={ocrResult}
        onChangeOcrItem={handleChangeOcrItem}
        onImportOcr={handleImportReviewedOcr}
        batchInput={batchInput}
        onChangeBatchInput={(value) => {
          cancelBatchRequest();
          setBatchInput(value);
          setBatchResult(null);
        }}
        onRunBatchAnalyze={handleBatchAnalyze}
        batchLoading={batchLoading}
        batchResult={batchResult}
        aiToolsError={aiToolsError}
        aiToolsMessage={aiToolsMessage}
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
          Wpisz kod dostępu otrzymany od osoby zarządzającej systemem.
        </Text>
        <TextInput
          testID="auth-token-input"
          accessibilityLabel="Kod dostępu"
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
