import { clearApiToken, getApiToken, setApiToken, subscribeToApiToken } from './authSession';

describe('in-memory credentials', () => {
  afterEach(() => clearApiToken());

  it('normalizes empty values and clears the business credential on logout', () => {
    setApiToken('   ');
    expect(getApiToken()).toBeNull();
    setApiToken(' user-token ');
    clearApiToken();
    expect(getApiToken()).toBeNull();
  });

  it('notifies active subscribers and stops after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToApiToken(listener);

    setApiToken('user-token');
    clearApiToken();
    unsubscribe();
    clearApiToken();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
