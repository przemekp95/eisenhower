import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import LanguageSwitcher from './src/components/LanguageSwitcher';
import { translations } from './src/i18n/translations';
import { suggestTaskQuadrant } from './src/services/ai';
import { loadLanguage, loadTasks, saveLanguage, saveTasks } from './src/services/storage';
import { scanTasksFromImage } from './src/services/media';
import {
  createRemoteTask,
  deleteRemoteTask,
  fetchRemoteTasks,
  isRemoteTaskId,
  updateRemoteTask,
} from './src/services/tasks';
import { createTaskRecord, getSampleTasks, mergeTasks } from './src/utils/taskUtils';

export default function App() {
  const [language, setLanguage] = useState('pl');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [newTask, setNewTask] = useState({
    title: '',
    description: '',
    urgent: false,
    important: false,
  });

  const t = translations[language];

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const nextLanguage = await loadLanguage();
        let cachedTasks = [];

        try {
          cachedTasks = await loadTasks(nextLanguage);
        } catch {
          cachedTasks = getSampleTasks(nextLanguage);
        }

        /* istanbul ignore next: defensive unmount guard during async bootstrap */
        if (!active) {
          return;
        }

        setLanguage(nextLanguage);
        setTasks(cachedTasks);
        setLoading(false);

        try {
          const remoteTasks = await fetchRemoteTasks(nextLanguage);
          await saveTasks(remoteTasks);

          /* istanbul ignore next: defensive unmount guard during async remote refresh */
          if (!active) {
            return;
          }

          setTasks(remoteTasks);
          setNotice(translations[nextLanguage].syncedRemote);
        } catch {
          /* istanbul ignore next: defensive unmount guard during async remote fallback */
          if (!active) {
            return;
          }

          setNotice(translations[nextLanguage].cachedLocal);
        }
      } catch {
        /* istanbul ignore next: defensive unmount guard during async bootstrap failure */
        if (!active) {
          return;
        }

        setLanguage('pl');
        setTasks(getSampleTasks('pl'));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const persistTasks = async (nextTasks, nextNotice = '') => {
    setTasks(nextTasks);
    setNotice(nextNotice);
    await saveTasks(nextTasks);
  };

  const handleLanguageChange = async (nextLanguage) => {
    setLanguage(nextLanguage);
    setNotice('');
    await saveLanguage(nextLanguage);
  };

  const handleAddTask = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    const localTask = createTaskRecord(language, newTask, `local-${Date.now()}`);

    try {
      const remoteTask = await createRemoteTask(localTask, language);
      await persistTasks([remoteTask, ...tasks], t.syncedRemote);
    } catch {
      await persistTasks([localTask, ...tasks], t.cachedLocal);
    }

    setNewTask({ title: '', description: '', urgent: false, important: false });
  };

  const handleSuggest = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    const suggestion = await suggestTaskQuadrant(newTask.title);
    setNewTask((current) => ({
      ...current,
      urgent: suggestion.urgent,
      important: suggestion.important,
    }));
    setNotice(suggestion.source === 'fallback' ? t.suggestionFailed : '');
  };

  const handleDelete = async (id) => {
    const nextTasks = tasks.filter((task) => task.id !== id);

    if (!isRemoteTaskId(id)) {
      await persistTasks(nextTasks, t.cachedLocal);
      return;
    }

    try {
      await deleteRemoteTask(id);
      await persistTasks(nextTasks, t.syncedRemote);
    } catch {
      await persistTasks(nextTasks, t.cachedLocal);
    }
  };

  const handleToggle = async (id, key) => {
    const toggledTask = tasks.find((task) => task.id === id);
    /* istanbul ignore next: stale press on a task that no longer exists */
    if (!toggledTask) {
      return;
    }

    const nextTask = { ...toggledTask, [key]: !toggledTask[key] };
    const nextTasks = tasks.map((task) => (task.id === id ? nextTask : task));

    if (!isRemoteTaskId(id)) {
      await persistTasks(nextTasks, t.cachedLocal);
      return;
    }

    try {
      const remoteTask = await updateRemoteTask(id, { [key]: nextTask[key] }, language);
      await persistTasks(
        tasks.map((task) => (task.id === id ? remoteTask : task)),
        t.syncedRemote
      );
    } catch {
      await persistTasks(nextTasks, t.cachedLocal);
    }
  };

  const handleScan = async () => {
    try {
      const scanned = await scanTasksFromImage(language);
      if (scanned.length === 0) {
        setNotice(t.ocrEmpty);
        return;
      }

      const createdTasks = await Promise.all(
        scanned.map(async (task) => {
          try {
            return await createRemoteTask(task, language);
          } catch {
            return task;
          }
        })
      );

      await persistTasks(mergeTasks(tasks, createdTasks), t.ocrAdded);
    } catch {
      setNotice(t.ocrFailed);
    }
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

      <View style={styles.form}>
        <TextInput
          value={newTask.title}
          onChangeText={(value) => setNewTask((current) => ({ ...current, title: value }))}
          placeholder={t.titlePlaceholder}
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
        <TextInput
          value={newTask.description}
          onChangeText={(value) => setNewTask((current) => ({ ...current, description: value }))}
          placeholder={t.descriptionPlaceholder}
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t.urgent}</Text>
          <Switch
            testID="new-task-urgent-switch"
            value={newTask.urgent}
            onValueChange={(value) => setNewTask((current) => ({ ...current, urgent: value }))}
          />
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t.important}</Text>
          <Switch
            testID="new-task-important-switch"
            value={newTask.important}
            onValueChange={(value) => setNewTask((current) => ({ ...current, important: value }))}
          />
        </View>
        <View style={styles.actions}>
          <Pressable testID="add-task-button" onPress={handleAddTask} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{t.addTask}</Text>
          </Pressable>
          <Pressable testID="suggest-task-button" onPress={handleSuggest} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{t.suggest}</Text>
          </Pressable>
          <Pressable testID="scan-task-button" onPress={handleScan} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{t.scan}</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>{t.empty}</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardDescription}>{item.description}</Text>
              </View>
              <Pressable
                testID={`delete-task-${item.id}`}
                onPress={() => handleDelete(item.id)}
                style={styles.deleteButton}
              >
                <Text style={styles.deleteButtonText}>{t.delete}</Text>
              </Pressable>
            </View>
            <View style={styles.badges}>
              <Pressable
                testID={`toggle-urgent-${item.id}`}
                onPress={() => handleToggle(item.id, 'urgent')}
                style={styles.badge}
              >
                <Text style={styles.badgeText}>{t.urgent}: {item.urgent ? t.on : t.off}</Text>
              </Pressable>
              <Pressable
                testID={`toggle-important-${item.id}`}
                onPress={() => handleToggle(item.id, 'important')}
                style={styles.badge}
              >
                <Text style={styles.badgeText}>{t.important}: {item.important ? t.on : t.off}</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#020617',
    padding: 16,
  },
  loading: {
    marginTop: 40,
    color: '#e2e8f0',
    textAlign: 'center',
  },
  header: {
    marginBottom: 20,
    gap: 12,
  },
  title: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#94a3b8',
    marginTop: 6,
  },
  notice: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
    backgroundColor: '#10243f',
  },
  noticeText: {
    color: '#bfdbfe',
    fontWeight: '600',
  },
  form: {
    gap: 12,
    borderRadius: 24,
    padding: 16,
    marginBottom: 20,
    backgroundColor: '#0f172a',
  },
  input: {
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#111827',
    color: '#f8fafc',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  switchLabel: {
    color: '#e2e8f0',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  primaryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#14b8a6',
  },
  primaryButtonText: {
    color: '#042f2e',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
  },
  secondaryButtonText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  empty: {
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 32,
  },
  card: {
    gap: 12,
    marginBottom: 12,
    borderRadius: 20,
    padding: 16,
    backgroundColor: '#0f172a',
  },
  cardHeader: {
    flexDirection: 'row',
    gap: 12,
  },
  cardTitle: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  cardDescription: {
    marginTop: 4,
    color: '#94a3b8',
  },
  deleteButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#7f1d1d',
  },
  deleteButtonText: {
    color: '#fee2e2',
    fontWeight: '700',
  },
  badges: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
  },
  badgeText: {
    color: '#cbd5e1',
  },
});
