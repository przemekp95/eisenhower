import { act, render, waitFor } from '@testing-library/react';

describe('motion fallback paths', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('handles app motion import failures both before and after unmount', async () => {
    jest.doMock('react', () => jest.requireActual('react'));
    jest.doMock('react/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
    jest.doMock('./hooks/useSmoothScroll', () => ({
      __esModule: true,
      default: jest.fn(),
    }));
    jest.doMock('./lib/motion', () => ({
      shouldDisableMotion: () => false,
    }));
    jest.doMock('./i18n/LanguageContext', () => ({
      __esModule: true,
      LanguageProvider: ({ children }: { children: unknown }) => children,
      useLanguage: () => ({
        language: 'pl',
        setLanguage: jest.fn(),
        t: (key: string) => key,
      }),
    }));
    jest.doMock('./services/api', () => ({
      getTasks: jest.fn().mockResolvedValue([]),
      createTask: jest.fn(),
      updateTask: jest.fn(),
      deleteTask: jest.fn(),
    }));
    jest.doMock('./components/Matrix', () => ({
      __esModule: true,
      default: () => null,
    }));
    jest.doMock('./components/LanguageSwitcher', () => ({
      __esModule: true,
      default: () => null,
    }));
    jest.doMock('gsap', () => {
      throw new Error('GSAP unavailable');
    });

    const { default: App } = await import('./App');

    const firstView = render(<App />);

    await waitFor(() =>
      expect(document.querySelector('main')).toHaveAttribute('data-app-intro', 'ready')
    );
    firstView.unmount();

    const { unmount } = render(<App />);
    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('main')).not.toBeInTheDocument();
  });

  it('swallows failed matrix motion setup after unmount', async () => {
    jest.doMock('react', () => jest.requireActual('react'));
    jest.doMock('react/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
    jest.doMock('./lib/motion', () => ({
      shouldDisableMotion: () => false,
    }));
    jest.doMock('./i18n/LanguageContext', () => ({
      __esModule: true,
      LanguageProvider: ({ children }: { children: unknown }) => children,
      useLanguage: () => ({
        language: 'pl',
        setLanguage: jest.fn(),
        t: (key: string) => key,
      }),
    }));
    jest.doMock('./services/api', () => ({
      classifyTask: jest.fn(),
    }));
    jest.doMock('./components/AITools', () => ({
      __esModule: true,
      default: () => null,
    }));
    jest.doMock('./components/MatrixScene', () => ({
      __esModule: true,
      default: () => null,
    }));
    jest.doMock('gsap', () => {
      throw new Error('GSAP unavailable');
    });

    const { default: Matrix } = await import('./components/Matrix');

    const { unmount } = render(
      <Matrix
        tasks={[]}
        loading={false}
        onAddTask={jest.fn()}
        onUpdateTask={jest.fn()}
        onDeleteTask={jest.fn()}
      />
    );
    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('[data-matrix-intro]')).not.toBeInTheDocument();
  });
});
