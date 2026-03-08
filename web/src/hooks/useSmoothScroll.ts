import { useEffect } from 'react';
import { shouldDisableMotion } from '../lib/motion';

export default function useSmoothScroll() {
  useEffect(() => {
    if (shouldDisableMotion()) {
      return;
    }

    let cleanup = () => {};
    let cancelled = false;

    void (async () => {
      const { default: Lenis } = await import('lenis');

      if (cancelled) {
        return;
      }

      const lenis = new Lenis({
        autoRaf: false,
        duration: 1.05,
        smoothWheel: true,
        syncTouch: false,
        wheelMultiplier: 0.92,
        touchMultiplier: 1.05,
      });

      let frameId = 0;

      const onFrame = (time: number) => {
        lenis.raf(time);
        frameId = window.requestAnimationFrame(onFrame);
      };

      frameId = window.requestAnimationFrame(onFrame);

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        lenis.destroy();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
}
