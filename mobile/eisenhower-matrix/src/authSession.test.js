import { clearApiToken, getApiToken, setApiToken, subscribeToApiToken } from './authSession';

describe('in-memory credentials', () => {
  afterEach(() => clearApiToken());

  it('keeps the runtime access credential in memory without persisting it', () => {
    setApiToken(' user-token ');
    expect(getApiToken()).toBe('user-token');
  });

  it('normalizes empty values and notifies only active subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    setApiToken(null);
    unsubscribe();
    clearApiToken();

    expect(getApiToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when the access credential is cleared', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    clearApiToken();

    expect(getApiToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
