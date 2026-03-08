import { useEffect, useMemo, useRef, useState } from 'react';
import Matrix from './components/Matrix';
import LanguageSwitcher from './components/LanguageSwitcher';
import useSmoothScroll from './hooks/useSmoothScroll';
import { LanguageProvider, useLanguage } from './i18n/LanguageContext';
import { shouldDisableMotion } from './lib/motion';
import { replaceTaskById, restoreReadyState } from './lib/uiState';
import { createTask, deleteTask, getTasks, updateTask } from './services/api';
import { Task, TaskInput } from './types';

function AppContent() {
  const { t } = useLanguage();
  const mainRef = useRef<HTMLElement | null>(null);
  const [appIntroState, setAppIntroState] = useState<'pending' | 'ready'>(() =>
    shouldDisableMotion() ? 'ready' : 'pending'
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const heroMetrics = useMemo(() => {
    const total = tasks.length;
    const critical = tasks.filter((task) => task.urgent && task.important).length;
    const leverage = tasks.filter((task) => !task.urgent && task.important).length;
    const noise = Math.max(total - critical - leverage, 0);
    const safeTotal = Math.max(total, 1);

    return {
      cards: [
        { label: t('hero.metrics.total'), value: total, accent: 'from-emerald-300/70 to-cyan-300/60' },
        { label: t('hero.metrics.focus'), value: critical, accent: 'from-cyan-300/80 to-sky-300/70' },
        { label: t('hero.metrics.leverage'), value: leverage, accent: 'from-amber-300/80 to-orange-300/70' },
      ],
      bands: [
        { label: t('hero.bands.critical'), value: critical, width: 24 + (critical / safeTotal) * 76, tone: 'from-emerald-300 to-cyan-300' },
        { label: t('hero.bands.depth'), value: leverage, width: 24 + (leverage / safeTotal) * 76, tone: 'from-cyan-300 to-blue-300' },
        { label: t('hero.bands.reserve'), value: noise, width: 24 + (noise / safeTotal) * 76, tone: 'from-slate-300/70 to-slate-500/60' },
      ],
    };
  }, [tasks, t]);

  useSmoothScroll();

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextTasks = await getTasks();
      setTasks(nextTasks);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, []);

  useEffect(() => {
    const root = mainRef.current;

    if (!root || shouldDisableMotion()) {
      return;
    }

    let cleanup = () => {};
    let cancelled = false;
    let scrollFrame = 0;

    void (async () => {
      const { gsap } = await import('gsap');

      if (cancelled) {
        return;
      }

      const ctx = gsap.context(() => {
        const intro = gsap.timeline({
          defaults: {
            duration: 0.88,
            ease: 'power3.out',
          },
          onComplete: () => {
            if (!cancelled) {
              setAppIntroState('ready');
            }
          },
        });

        intro
          .to('[data-app-shell]', { y: 0, autoAlpha: 1, scale: 1 })
          .to('[data-app-eyebrow]', { y: 0, autoAlpha: 1 }, '-=0.55')
          .to('[data-app-title]', { y: 0, autoAlpha: 1 }, '-=0.52')
          .to('[data-app-subtitle]', { y: 0, autoAlpha: 1 }, '-=0.52')
          .to('[data-app-badge]', { y: 0, autoAlpha: 1, stagger: 0.06 }, '-=0.54')
          .to('[data-app-stat]', { y: 0, autoAlpha: 1, stagger: 0.08 }, '-=0.56')
          .to('[data-app-preview]', { x: 0, autoAlpha: 1, scale: 1 }, '-=0.7')
          .to('[data-app-actions]', { y: 0, autoAlpha: 1 }, '-=0.72')
          .to(
            '[data-app-matrix]',
            {
              y: 0,
              autoAlpha: 1,
              scale: 1,
              duration: 0.92,
            },
            '-=0.45'
          )
          .to('[data-app-footer]', { y: 0, autoAlpha: 1 }, '-=0.38');

        gsap.to('[data-app-preview-layer]', {
          y: -16,
          x: 10,
          duration: 4.8,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          stagger: 0.2,
        });

        gsap.to('[data-app-band]', {
          backgroundPositionX: '140%',
          duration: 8,
          ease: 'none',
          repeat: -1,
          stagger: 0.25,
        });

        gsap.to('[data-app-orbit]', {
          rotation: 360,
          duration: 16,
          ease: 'none',
          repeat: -1,
        });
      }, root);

      const shell = root.querySelector<HTMLElement>('[data-app-shell]');
      const preview = root.querySelector<HTMLElement>('[data-app-preview]');
      const backdrop = root.querySelector<HTMLElement>('[data-app-backdrop]');
      const badgeRail = root.querySelector<HTMLElement>('[data-app-badges]');

      const syncScrollMotion = () => {
        scrollFrame = 0;

        const progress = Math.min(window.scrollY / 420, 1);

        if (shell) {
          gsap.to(shell, {
            y: progress * -18,
            scale: 1 - progress * 0.018,
            duration: 0.9,
            ease: 'power3.out',
            overwrite: 'auto',
          });
        }

        if (preview) {
          gsap.to(preview, {
            y: progress * 24,
            duration: 0.9,
            ease: 'power3.out',
            overwrite: 'auto',
          });
        }

        if (backdrop) {
          gsap.to(backdrop, {
            y: progress * -28,
            opacity: 1 - progress * 0.22,
            duration: 1,
            ease: 'power3.out',
            overwrite: 'auto',
          });
        }

        if (badgeRail) {
          gsap.to(badgeRail, {
            x: progress * 10,
            duration: 0.8,
            ease: 'power2.out',
            overwrite: 'auto',
          });
        }
      };

      const handleScroll = () => {
        if (scrollFrame) {
          return;
        }

        scrollFrame = window.requestAnimationFrame(syncScrollMotion);
      };

      window.addEventListener('scroll', handleScroll, { passive: true });

      cleanup = () => {
        window.removeEventListener('scroll', handleScroll);
        window.cancelAnimationFrame(scrollFrame);
        ctx.revert();
      };
    })().catch(() => {
      restoreReadyState(cancelled, () => setAppIntroState('ready'));
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const handleAddTask = async (task: TaskInput) => {
    try {
      const created = await createTask(task);
      setTasks((current) => [created, ...current]);
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  const handleUpdateTask = async (id: string, patch: Partial<TaskInput>) => {
    try {
      const updated = await updateTask(id, patch);
      setTasks((current) => replaceTaskById(current, id, updated));
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  const handleDeleteTask = async (id: string) => {
    try {
      await deleteTask(id);
      setTasks((current) => current.filter((task) => task._id !== id));
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  const badges = [t('hero.badges.api'), t('hero.badges.ai'), t('hero.badges.motion')];
  const footerCards = [
    { label: t('footer.cards.board'), value: t('footer.cards.boardValue') },
    { label: t('footer.cards.sync'), value: t('footer.cards.syncValue') },
    { label: t('footer.cards.motion'), value: t('footer.cards.motionValue') },
  ];

  return (
    <main
      ref={mainRef}
      data-app-intro={appIntroState}
      className="relative min-h-screen overflow-hidden bg-[#030816] px-4 py-6 text-white sm:py-8"
    >
      <div aria-hidden="true" className="app-noise" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_18%_18%,rgba(16,185,129,0.18),transparent_28%),radial-gradient(circle_at_82%_14%,rgba(56,189,248,0.22),transparent_26%),linear-gradient(180deg,rgba(2,6,23,0),rgba(2,6,23,0.6))]"
      />

      <div className="relative mx-auto max-w-6xl">
        <section
          data-app-shell
          className="hero-shell relative mb-8 overflow-hidden rounded-[2.75rem] border border-white/10 bg-slate-950/[0.65] shadow-[0_32px_120px_rgba(2,6,23,0.62)] backdrop-blur-xl"
        >
          <div data-app-backdrop aria-hidden="true" className="hero-backdrop" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(20,184,166,0.18),transparent_38%,rgba(2,6,23,0)_68%),radial-gradient(circle_at_center,rgba(255,255,255,0.04),transparent_58%)]"
          />

          <div className="relative z-10 grid gap-8 px-6 py-8 lg:px-8 xl:grid-cols-[minmax(0,1.15fr)_24rem] xl:py-10">
            <div className="flex flex-col">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p
                    data-app-eyebrow
                    className="flex items-center gap-3 text-sm uppercase tracking-[0.35em] text-emerald-200/80"
                  >
                    <span
                      aria-hidden="true"
                      className="pulse-dot size-2 rounded-full bg-emerald-300 text-emerald-300"
                    />
                    {t('app.eyebrow')}
                  </p>
                  <h1
                    data-app-title
                    className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl"
                  >
                    {t('app.title')}
                  </h1>
                  <p data-app-subtitle className="mt-4 max-w-2xl text-base leading-7 text-white/[0.68] sm:text-lg">
                    {t('app.subtitle')}
                  </p>
                </div>

                <div data-app-actions className="flex flex-wrap items-center gap-3 lg:justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      void loadTasks();
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
                  >
                    {t('form.refresh')}
                  </button>
                  <LanguageSwitcher />
                </div>
              </div>

              <div data-app-badges className="mt-8 flex flex-wrap gap-3">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    data-app-badge
                    className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs uppercase tracking-[0.24em] text-white/[0.65] backdrop-blur"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            </div>

            <aside data-app-preview className="hero-preview-mask relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/[0.55] p-5 backdrop-blur-md">
              <div
                data-app-preview-layer
                aria-hidden="true"
                className="pointer-events-none absolute -right-10 top-4 h-36 w-36 rounded-full bg-cyan-300/16 blur-3xl"
              />
              <div
                data-app-preview-layer
                aria-hidden="true"
                className="pointer-events-none absolute -left-8 bottom-4 h-32 w-32 rounded-full bg-emerald-300/14 blur-3xl"
              />
              <div
                data-app-orbit
                aria-hidden="true"
                className="pointer-events-none absolute right-5 top-5 h-24 w-24 rounded-full border border-white/[0.08]"
              >
                <div className="absolute inset-3 rounded-full border border-white/[0.07]" />
                <div className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-cyan-200 shadow-[0_0_18px_rgba(103,232,249,0.8)]" />
              </div>

              <div className="relative z-10">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.26em] text-white/45">{t('hero.preview.title')}</p>
                    <p className="mt-3 max-w-xs text-sm leading-6 text-white/[0.72]">{t('hero.preview.description')}</p>
                  </div>
                  <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-200/80">
                    {t('hero.status')}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-3">
                  {heroMetrics.cards.map((metric) => (
                    <div
                      key={metric.label}
                      data-app-stat
                      className="rounded-[1.4rem] border border-white/10 bg-white/[0.06] p-4 backdrop-blur"
                    >
                      <div className={`h-1 rounded-full bg-gradient-to-r ${metric.accent}`} />
                      <p className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-white">
                        {String(metric.value).padStart(2, '0')}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-[0.24em] text-white/45">{metric.label}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-5 rounded-[1.6rem] border border-white/10 bg-slate-950/[0.58] p-4">
                  <div className="space-y-4">
                    {heroMetrics.bands.map((band) => (
                      <div key={band.label}>
                        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-white/[0.42]">
                          <span>{band.label}</span>
                          <span>{String(band.value).padStart(2, '0')}</span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            data-app-band
                            className={`h-full rounded-full bg-[length:170%_100%] bg-gradient-to-r ${band.tone}`}
                            style={{ width: `${band.width}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>

        {error ? (
          <div className="mb-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        ) : null}

        {loading ? <p className="mb-4 text-sm text-white/70">{t('status.loading')}</p> : null}

        <div data-app-matrix>
          <Matrix
            tasks={tasks}
            loading={loading}
            onAddTask={handleAddTask}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
          />
        </div>

        <footer
          data-app-footer
          className="relative mt-8 overflow-hidden rounded-[2.25rem] border border-white/10 bg-slate-950/[0.52] p-6 shadow-[0_24px_70px_rgba(2,6,23,0.38)] backdrop-blur-xl"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_18%,rgba(16,185,129,0.14),transparent_24%),radial-gradient(circle_at_88%_20%,rgba(56,189,248,0.16),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))]"
          />

          <div className="relative z-10 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_24rem]">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-white/45">{t('footer.kicker')}</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-white sm:text-3xl">
                {t('app.title')}
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/[0.7] sm:text-base">
                {t('footer.summary')}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              {footerCards.map((card) => (
                <div
                  key={card.label}
                  className="rounded-[1.4rem] border border-white/10 bg-white/[0.05] px-4 py-3 backdrop-blur"
                >
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/42">{card.label}</p>
                  <p className="mt-2 text-sm font-medium text-white/82">{card.value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 mt-6 flex flex-col gap-4 border-t border-white/10 pt-4 text-xs text-white/48 sm:flex-row sm:items-center sm:justify-between">
            <p>{t('footer.legal')}</p>
            <div className="flex flex-wrap gap-2">
              {badges.map((badge) => (
                <span
                  key={`footer-${badge}`}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 uppercase tracking-[0.2em] text-white/52"
                >
                  {badge}
                </span>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
