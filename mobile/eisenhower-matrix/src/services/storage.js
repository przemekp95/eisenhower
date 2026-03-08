import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSampleTasks } from '../utils/taskUtils';

const TASKS_KEY = 'eisenhower-mobile/tasks';
const LANGUAGE_KEY = 'eisenhower-mobile/language';

export async function loadLanguage() {
  const stored = await AsyncStorage.getItem(LANGUAGE_KEY);
  return stored === 'en' || stored === 'pl' ? stored : 'pl';
}

export async function saveLanguage(language) {
  await AsyncStorage.setItem(LANGUAGE_KEY, language);
}

export async function loadTasks(language) {
  const stored = await AsyncStorage.getItem(TASKS_KEY);
  return stored ? JSON.parse(stored) : getSampleTasks(language);
}

export async function saveTasks(tasks) {
  await AsyncStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}
