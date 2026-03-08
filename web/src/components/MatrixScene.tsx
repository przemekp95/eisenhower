import { useEffect, useRef } from 'react';
import { Application, Container, Graphics } from 'pixi.js';

type Halo = {
  graphic: Graphics;
  anchorX: number;
  anchorY: number;
  drift: number;
  pulse: number;
};

type Particle = {
  graphic: Graphics;
  anchorX: number;
  anchorY: number;
  orbit: number;
  speed: number;
  phase: number;
  pull: number;
  wobble: number;
};

const QUADRANTS = [
  { x: 0.27, y: 0.28, color: 0x34d399 },
  { x: 0.73, y: 0.28, color: 0x67e8f9 },
  { x: 0.27, y: 0.72, color: 0xf59e0b },
  { x: 0.73, y: 0.72, color: 0xfb7185 },
];

export default function MatrixScene() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    let mounted = true;
    let initialized = false;
    let destroyed = false;
    let initFrame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const app = new Application();
    const haloLayer = new Container();
    const grid = new Graphics();
    const trace = new Graphics();
    const centerBeacon = new Graphics();
    const particleLayer = new Container();

    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const halos: Halo[] = [];
    const particles: Particle[] = [];
    let tickerCallback: ((ticker: { deltaTime: number }) => void) | null = null;

    const destroyApp = () => {
      if (destroyed || !initialized) {
        return;
      }

      destroyed = true;

      if (tickerCallback) {
        app.ticker.remove(tickerCallback);
        tickerCallback = null;
      }

      resizeObserver?.disconnect();
      resizeObserver = null;

      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', handlePointerLeave);

      if (app.canvas.parentNode === host) {
        host.removeChild(app.canvas);
      }

      app.destroy(true, { children: true });
    };

    const syncPointerToCenter = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;

      pointer.x = width / 2;
      pointer.y = height / 2;
      pointer.targetX = width / 2;
      pointer.targetY = height / 2;
    };

    const redrawGrid = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      const padding = Math.max(26, Math.min(width, height) * 0.04);

      grid.clear();
      grid
        .roundRect(padding, padding, width - padding * 2, height - padding * 2, 34)
        .stroke({ width: 1, color: 0x60a5fa, alpha: 0.14 })
        .moveTo(width / 2, padding + 18)
        .lineTo(width / 2, height - padding - 18)
        .moveTo(padding + 18, height / 2)
        .lineTo(width - padding - 18, height / 2)
        .stroke({ width: 1.5, color: 0x67e8f9, alpha: 0.11 });

      centerBeacon
        .clear()
        .circle(0, 0, 4)
        .fill({ color: 0xffffff, alpha: 0.58 })
        .circle(0, 0, 18)
        .stroke({ width: 1, color: 0x67e8f9, alpha: 0.14 });
      centerBeacon.position.set(width / 2, height / 2);
    };

    const updatePointer = (clientX?: number, clientY?: number) => {
      const rect = host.getBoundingClientRect();

      if (clientX == null || clientY == null) {
        pointer.targetX = rect.width / 2;
        pointer.targetY = rect.height / 2;
        return;
      }

      pointer.targetX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      pointer.targetY = Math.min(Math.max(clientY - rect.top, 0), rect.height);
    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePointer(event.clientX, event.clientY);
    };

    const handlePointerLeave = () => {
      updatePointer();
    };

    const initializeScene = async () => {
      await app.init({
        width: host.clientWidth || 1,
        height: host.clientHeight || 1,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        preference: 'webgl',
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });

      initialized = true;

      if (!mounted) {
        destroyApp();
        return;
      }

      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.pointerEvents = 'none';
      host.appendChild(app.canvas);

      app.stage.addChild(haloLayer);
      app.stage.addChild(grid);
      app.stage.addChild(trace);
      app.stage.addChild(particleLayer);
      app.stage.addChild(centerBeacon);

      QUADRANTS.forEach((quadrant, index) => {
        const halo = new Graphics()
          .circle(0, 0, 1)
          .fill({ color: quadrant.color, alpha: 0.16 });

        haloLayer.addChild(halo);
        halos.push({
          graphic: halo,
          anchorX: quadrant.x,
          anchorY: quadrant.y,
          drift: 12 + index * 3,
          pulse: index * 0.9,
        });

        for (let i = 0; i < 4; i += 1) {
          const particle = new Graphics()
            .circle(0, 0, 1)
            .fill({ color: quadrant.color, alpha: 0.9 });

          particle.scale.set(2 + ((index + i) % 3));
          particleLayer.addChild(particle);
          particles.push({
            graphic: particle,
            anchorX: quadrant.x,
            anchorY: quadrant.y,
            orbit: 18 + i * 10 + index * 4,
            speed: 0.55 + i * 0.08 + index * 0.04,
            phase: index * 0.8 + i * 1.6,
            pull: 0.015 + i * 0.004,
            wobble: 0.7 + i * 0.12,
          });
        }
      });

      syncPointerToCenter();
      redrawGrid();

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          app.renderer.resize(host.clientWidth || 1, host.clientHeight || 1);
          redrawGrid();
          updatePointer();
        });
        resizeObserver.observe(host);
      }

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerleave', handlePointerLeave);

      tickerCallback = (ticker) => {
        const width = app.renderer.width || host.clientWidth || 1;
        const height = app.renderer.height || host.clientHeight || 1;
        const time = performance.now() * 0.001;
        const influenceX = (pointer.x - width / 2) / width;
        const influenceY = (pointer.y - height / 2) / height;

        pointer.x += (pointer.targetX - pointer.x) * 0.045 * ticker.deltaTime;
        pointer.y += (pointer.targetY - pointer.y) * 0.045 * ticker.deltaTime;

        halos.forEach((halo) => {
          const baseRadius = Math.min(width, height) * 0.17;
          const pulse = 0.94 + Math.sin(time * 0.8 + halo.pulse) * 0.08;

          halo.graphic.position.set(
            width * halo.anchorX + influenceX * halo.drift * width * 0.08,
            height * halo.anchorY + influenceY * halo.drift * height * 0.08
          );
          halo.graphic.scale.set(baseRadius * pulse, baseRadius * (pulse * 0.84));
          halo.graphic.alpha = 0.07 + Math.sin(time * 1.1 + halo.pulse) * 0.025;
        });

        particles.forEach((particle, index) => {
          const baseX = width * particle.anchorX;
          const baseY = height * particle.anchorY;
          const angle = time * particle.speed + particle.phase;
          const x = baseX + Math.cos(angle) * particle.orbit + influenceX * width * particle.pull * 10;
          const y = baseY + Math.sin(angle * particle.wobble) * particle.orbit * 0.72 + influenceY * height * particle.pull * 10;

          particle.graphic.position.set(x, y);
          particle.graphic.alpha = 0.35 + Math.sin(time * 1.8 + index) * 0.15;
        });

        centerBeacon.scale.set(1 + Math.sin(time * 1.4) * 0.05);
        centerBeacon.alpha = 0.72 + Math.sin(time * 1.6) * 0.08;

        trace
          .clear()
          .moveTo(width / 2, height / 2)
          .lineTo(pointer.x, pointer.y)
          .stroke({ width: 1, color: 0x67e8f9, alpha: 0.08 })
          .circle(pointer.x, pointer.y, 4)
          .fill({ color: 0xffffff, alpha: 0.24 })
          .circle(pointer.x, pointer.y, 14)
          .stroke({ width: 1, color: 0x67e8f9, alpha: 0.12 });
      };

      app.ticker.add(tickerCallback);
    };

    initFrame = window.requestAnimationFrame(() => {
      void initializeScene();
    });

    return () => {
      mounted = false;
      window.cancelAnimationFrame(initFrame);
      destroyApp();
    };
  }, []);

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 opacity-80" aria-hidden="true" />;
}
