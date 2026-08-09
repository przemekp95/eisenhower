import {
  clearAdminToken,
  clearApiToken,
  getAdminToken,
  getApiToken,
  setAdminToken,
  setApiToken,
  setCredentials,
  subscribeToApiToken,
} from './authSession';

describe('in-memory credentials', () => {
  afterEach(() => clearApiToken());

  it('keeps user and administrator credentials separate and trims them', () => {
    setCredentials(' user-token ', ' admin-token ');

    expect(getApiToken()).toBe('user-token');
    expect(getAdminToken()).toBe('admin-token');

    clearAdminToken();

    expect(getApiToken()).toBe('user-token');
    expect(getAdminToken()).toBeNull();
  });

  it('normalizes empty values and clears both credentials on logout', () => {
    setApiToken('   ');
    setAdminToken('   ');

    expect(getApiToken()).toBeNull();
    expect(getAdminToken()).toBeNull();

    setCredentials('   ', '   ');
    expect(getApiToken()).toBeNull();
    expect(getAdminToken()).toBeNull();

    setCredentials('user-token', 'admin-token');
    clearApiToken();

    expect(getApiToken()).toBeNull();
    expect(getAdminToken()).toBeNull();
  });

  it('notifies active subscribers and stops after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    setApiToken('user-token');
    setAdminToken('admin-token');
    setCredentials('new-user-token', 'new-admin-token');
    clearAdminToken();
    clearApiToken();
    unsubscribe();
    clearAdminToken();

    expect(listener).toHaveBeenCalledTimes(5);
  });
});
