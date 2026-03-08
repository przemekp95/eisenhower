import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import LanguageSwitcher from './src/components/LanguageSwitcher';
import { translations } from './src/i18n/translations';
import { suggestTaskQuadrant } from './src/services/ai';
import { loadLanguage, loadTasks, saveLanguage, saveTasks } from './src/services/storage';
import { scanTasksFromImage } from './src/services/media';
import { createTaskRecord, getSampleTasks } from './src/utils/taskUtils';

export default function App() {
  const [language, setLanguage] = useState('pl');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
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
        const nextTasks = await loadTasks(nextLanguage);

        if (!active) {
          return;
        }

        setLanguage(nextLanguage);
        setTasks(nextTasks);
      } catch {
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

  const persistTasks = async (nextTasks) => {
    setTasks(nextTasks);
    await saveTasks(nextTasks);
  };

  const handleLanguageChange = async (nextLanguage) => {
    setLanguage(nextLanguage);
    await saveLanguage(nextLanguage);
  };

  const handleAddTask = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    const nextTasks = [
      createTaskRecord(language, newTask, `task-${Date.now()}`),
      ...tasks,
    ];

    await persistTasks(nextTasks);
    setNewTask({ title: '', description: '', urgent: false, important: false });
  };

  const handleSuggest = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    const suggestion = await suggestTaskQuadrant(newTask.title);
    setNewTask((current) => ({ ...current, ...suggestion }));
  };

  const handleDelete = async (id) => {
    await persistTasks(tasks.filter((task) => task.id !== id));
  };

  const handleToggle = async (id, key) => {
    await persistTasks(
      tasks.map((task) => (task.id === id ? { ...task, [key]: !task[key] } : task))
    );
  };

  const handleScan = async () => {
    const scanned = await scanTasksFromImage();
    if (scanned.length > 0) {
      await persistTasks([...scanned, ...tasks]);
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
            value={newTask.urgent}
            onValueChange={(value) => setNewTask((current) => ({ ...current, urgent: value }))}
          />
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t.important}</Text>
          <Switch
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
                <Text style={styles.badgeText}>{t.urgent}: {item.urgent ? 'on' : 'off'}</Text>
              </Pressable>
              <Pressable
                testID={`toggle-important-${item.id}`}
                onPress={() => handleToggle(item.id, 'important')}
                style={styles.badge}
              >
                <Text style={styles.badgeText}>{t.important}: {item.important ? 'on' : 'off'}</Text>
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
