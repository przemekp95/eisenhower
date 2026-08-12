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

  it('keeps credentials separate without persisting them', () => {
    setCredentials(' user-token ', ' admin-token ');

    expect(getApiToken()).toBe('user-token');
    expect(getAdminToken()).toBe('admin-token');

    clearAdminToken();
    expect(getApiToken()).toBe('user-token');
    expect(getAdminToken()).toBeNull();
  });

  it('normalizes empty values and notifies only active subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    setApiToken(null);
    setAdminToken(undefined);
    unsubscribe();
    clearApiToken();

    expect(getApiToken()).toBeNull();
    expect(getAdminToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers when both credentials are cleared together or admin is cleared', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    setCredentials(null, undefined);
    clearAdminToken();

    expect(getApiToken()).toBeNull();
    expect(getAdminToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
