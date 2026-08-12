import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadDelegatedTasks, loadLanguage, loadTasks, saveDelegatedTasks, saveLanguage, saveTasks } from './storage';
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
      {
        id: '1',
        title: 'Stored',
        description: '',
        urgent: false,
        important: false,
        locale: 'pl',
        remoteId: null,
        syncState: 'pending_create',
        clientOperationId: 'mobile-1',
        lifecycleState: 'active',
      },
    ]);
  });

  it('round-trips the persisted client operation id for pending creates', async () => {
    await saveTasks([{
      id: 'local-stable',
      title: 'Persisted retry',
      syncState: 'pending_create',
      clientOperationId: 'mobile-explicit-operation',
    }]);

    await expect(loadTasks('pl')).resolves.toEqual([
      expect.objectContaining({
        id: 'local-stable',
        clientOperationId: 'mobile-explicit-operation',
      }),
    ]);
  });

  it('falls back to localized seeds when stored JSON is invalid', async () => {
    await AsyncStorage.setItem('eisenhower-mobile/tasks', '{bad json');
    await expect(loadTasks('en')).resolves.toEqual(getSampleTasks('en'));
  });

  it('persists delegated work separately from owned tasks', async () => {
    await expect(loadDelegatedTasks('pl')).resolves.toEqual([]);
    await saveDelegatedTasks([{ id: 'delegated-1', title: 'Handoff', delegationRole: 'assignee' }]);
    await expect(loadDelegatedTasks('pl')).resolves.toEqual([
      expect.objectContaining({ id: 'delegated-1', delegationRole: 'assignee' }),
    ]);
    await AsyncStorage.setItem('eisenhower-mobile/delegated-tasks', '{bad json');
    await expect(loadDelegatedTasks('en')).resolves.toEqual([]);
  });
});
