import { useEffect, useRef } from 'react';
import { Container, Graphics, Ticker, WebGLRenderer } from 'pixi.js';
import { installPixiFirefoxWorkarounds } from './pixiFirefoxWorkarounds';

type Halo = {
  graphic: Graphics;
  anchorX: number;
  anchorY: number;
  drift: number;
  pulse: number;
  scaleX: number;
  scaleY: number;
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

type Ribbon = {
  graphic: Graphics;
  anchorY: number;
  amplitude: number;
  speed: number;
  phase: number;
  color: number;
  thickness: number;
  drag: number;
};

const QUADRANTS = [
  { x: 0.27, y: 0.28, color: 0x34d399 },
  { x: 0.73, y: 0.28, color: 0x67e8f9 },
  { x: 0.27, y: 0.72, color: 0xf59e0b },
  { x: 0.73, y: 0.72, color: 0xfb7185 },
];

const RIBBONS = [
  { anchorY: 0.2, amplitude: 28, speed: 0.42, phase: 0.2, color: 0x67e8f9, thickness: 1.2, drag: 0.16 },
  { anchorY: 0.34, amplitude: 22, speed: 0.36, phase: 1.4, color: 0x34d399, thickness: 1.4, drag: 0.12 },
  { anchorY: 0.62, amplitude: 30, speed: 0.33, phase: 2.2, color: 0xf59e0b, thickness: 1.1, drag: 0.08 },
  { anchorY: 0.78, amplitude: 20, speed: 0.46, phase: 3.1, color: 0xfb7185, thickness: 1.3, drag: 0.1 },
];

export default function MatrixScene() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    installPixiFirefoxWorkarounds();

    let mounted = true;
    let initialized = false;
    let destroyed = false;
    let initFrame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const renderer = new WebGLRenderer();
    const stage = new Container();
    const ticker = new Ticker();
    const backdrop = new Graphics();
    const ribbonLayer = new Container();
    const haloLayer = new Container();
    const grid = new Graphics();
    const trace = new Graphics();
    const spotlight = new Graphics();
    const centerBeacon = new Graphics();
    const particleLayer = new Container();

    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const halos: Halo[] = [];
    const particles: Particle[] = [];
    const ribbons: Ribbon[] = [];
    let tickerCallback: ((ticker: { deltaTime: number }) => void) | null = null;

    const destroyApp = () => {
      if (destroyed || !initialized) {
        return;
      }

      destroyed = true;

      if (tickerCallback) {
        ticker.remove(tickerCallback);
        tickerCallback = null;
      }

      ticker.destroy();

      resizeObserver?.disconnect();
      resizeObserver = null;

      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', handlePointerLeave);

      if (renderer.canvas.parentNode === host) {
        host.removeChild(renderer.canvas);
      }

      stage.destroy({ children: true });
      renderer.destroy(true);
    };

    const syncPointerToCenter = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;

      pointer.x = width / 2;
      pointer.y = height / 2;
      pointer.targetX = width / 2;
      pointer.targetY = height / 2;
    };

    const redrawBackdrop = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      const padding = Math.max(22, Math.min(width, height) * 0.04);

      backdrop.clear();
      backdrop.roundRect(padding, padding, width - padding * 2, height - padding * 2, 34).fill({
        color: 0x020617,
        alpha: 0.08,
      });

      QUADRANTS.forEach((quadrant, index) => {
        const radius = Math.min(width, height) * (0.16 + index * 0.01);

        backdrop.ellipse(width * quadrant.x, height * quadrant.y, radius, radius * 0.72).fill({
          color: quadrant.color,
          alpha: 0.028,
        });
      });

      for (let x = padding + 30; x < width - padding - 30; x += 68) {
        backdrop.moveTo(x, padding + 12).lineTo(x, height - padding - 12);
      }

      for (let y = padding + 26; y < height - padding - 26; y += 64) {
        backdrop.moveTo(padding + 12, y).lineTo(width - padding - 12, y);
      }

      backdrop.stroke({ width: 1, color: 0xffffff, alpha: 0.018 });
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
      await renderer.init({
        width: host.clientWidth || 1,
        height: host.clientHeight || 1,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });

      initialized = true;

      if (!mounted) {
        destroyApp();
        return;
      }

      renderer.canvas.style.width = '100%';
      renderer.canvas.style.height = '100%';
      renderer.canvas.style.pointerEvents = 'none';
      host.appendChild(renderer.canvas);

      stage.addChild(backdrop);
      stage.addChild(ribbonLayer);
      stage.addChild(haloLayer);
      stage.addChild(grid);
      stage.addChild(trace);
      stage.addChild(particleLayer);
      stage.addChild(spotlight);
      stage.addChild(centerBeacon);

      QUADRANTS.forEach((quadrant, index) => {
        const halo = new Graphics().ellipse(0, 0, 1, 1).fill({ color: quadrant.color, alpha: 0.16 });

        haloLayer.addChild(halo);
        halos.push({
          graphic: halo,
          anchorX: quadrant.x,
          anchorY: quadrant.y,
          drift: 12 + index * 3,
          pulse: index * 0.9,
          scaleX: 0.17 + index * 0.008,
          scaleY: 0.13 + index * 0.006,
        });

        for (let i = 0; i < 5; i += 1) {
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

      RIBBONS.forEach((config) => {
        const ribbon = new Graphics();
        ribbonLayer.addChild(ribbon);
        ribbons.push({ graphic: ribbon, ...config });
      });

      syncPointerToCenter();
      redrawBackdrop();
      redrawGrid();

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          renderer.resize(host.clientWidth || 1, host.clientHeight || 1);
          redrawBackdrop();
          redrawGrid();
          updatePointer();
        });
        resizeObserver.observe(host);
      }

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerleave', handlePointerLeave);

      tickerCallback = (ticker) => {
        const width = renderer.screen.width || host.clientWidth || 1;
        const height = renderer.screen.height || host.clientHeight || 1;
        const time = performance.now() * 0.001;

        pointer.x += (pointer.targetX - pointer.x) * 0.045 * ticker.deltaTime;
        pointer.y += (pointer.targetY - pointer.y) * 0.045 * ticker.deltaTime;

        const influenceX = (pointer.x - width / 2) / width;
        const influenceY = (pointer.y - height / 2) / height;

        halos.forEach((halo) => {
          const baseRadius = Math.min(width, height);
          const pulse = 0.94 + Math.sin(time * 0.8 + halo.pulse) * 0.08;

          halo.graphic.position.set(
            width * halo.anchorX + influenceX * halo.drift * width * 0.08,
            height * halo.anchorY + influenceY * halo.drift * height * 0.08
          );
          halo.graphic.scale.set(baseRadius * halo.scaleX * pulse, baseRadius * halo.scaleY * pulse);
          halo.graphic.alpha = 0.07 + Math.sin(time * 1.1 + halo.pulse) * 0.025;
        });

        ribbons.forEach((ribbon, index) => {
          const startX = -width * 0.08;
          const endX = width * 1.08;
          const segments = 6;

          ribbon.graphic.clear();

          for (let pass = 0; pass < 2; pass += 1) {
            for (let step = 0; step <= segments; step += 1) {
              const progress = step / segments;
              const x = startX + (endX - startX) * progress;
              const travel = time * ribbon.speed + ribbon.phase + progress * Math.PI * (pass === 0 ? 2.4 : 2.9);
              const wave = Math.sin(travel) * ribbon.amplitude;
              const crossWave = Math.cos(travel * 0.78 + progress * Math.PI * 3.5) * ribbon.amplitude * 0.38;
              const pull = influenceY * height * ribbon.drag * (progress - 0.5) * 2;
              const y = height * ribbon.anchorY + wave + crossWave + pull + pass * 7 - 3;

              if (step === 0) {
                ribbon.graphic.moveTo(x, y);
              } else {
                ribbon.graphic.lineTo(x, y);
              }
            }

            ribbon.graphic.stroke({
              width: ribbon.thickness - pass * 0.35,
              color: pass === 0 ? ribbon.color : 0xffffff,
              alpha: pass === 0 ? 0.12 + Math.sin(time * 0.9 + index) * 0.02 : 0.05,
            });
          }
        });

        particles.forEach((particle, index) => {
          const baseX = width * particle.anchorX;
          const baseY = height * particle.anchorY;
          const angle = time * particle.speed + particle.phase;
          const x = baseX + Math.cos(angle) * particle.orbit + influenceX * width * particle.pull * 10;
          const y =
            baseY +
            Math.sin(angle * particle.wobble) * particle.orbit * 0.72 +
            influenceY * height * particle.pull * 10;

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

        spotlight
          .clear()
          .circle(pointer.x, pointer.y, Math.min(width, height) * 0.18)
          .fill({ color: 0x67e8f9, alpha: 0.035 })
          .circle(pointer.x, pointer.y, Math.min(width, height) * 0.09)
          .fill({ color: 0x34d399, alpha: 0.024 })
          .circle(pointer.x, pointer.y, 38)
          .stroke({ width: 1, color: 0xffffff, alpha: 0.08 })
          .circle(pointer.x, pointer.y, 76)
          .stroke({ width: 1, color: 0x67e8f9, alpha: 0.06 });

        renderer.render({ container: stage });
      };

      ticker.add(tickerCallback);
      ticker.start();
    };

    initFrame = window.requestAnimationFrame(() => {
      void initializeScene().catch(() => {
        destroyApp();
      });
    });

    return () => {
      mounted = false;
      window.cancelAnimationFrame(initFrame);
      destroyApp();
    };
  }, []);

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 opacity-80" aria-hidden="true" />;
}
