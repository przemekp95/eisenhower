import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadLanguage, loadTasks, saveLanguage, saveTasks } from './storage';
import { getSampleTasks } from '../utils/taskUtils';

describe('storage service', () => {
  beforeEach(() => {
    AsyncStorage.clear();
  });

  it('defaults to polish when no language is stored', async () => {
    await expect(loadLanguage()).resolves.toBe('pl');
  });

  it('persists and reads language', async () => {
    await saveLanguage('en');
    await expect(loadLanguage()).resolves.toBe('en');
  });

  it('returns stored tasks or localized seeds', async () => {
    await expect(loadTasks('pl')).resolves.toHaveLength(2);
    await saveTasks([{ id: '1', title: 'Stored', description: '', urgent: false, important: false }]);
    await expect(loadTasks('pl')).resolves.toEqual([
      { id: '1', title: 'Stored', description: '', urgent: false, important: false },
    ]);
  });

  it('falls back to localized seeds when stored JSON is invalid', async () => {
    await AsyncStorage.setItem('eisenhower-mobile/tasks', '{bad json');
    await expect(loadTasks('en')).resolves.toEqual(getSampleTasks('en'));
  });
});
