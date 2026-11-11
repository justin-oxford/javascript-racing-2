import { createWorld, resetCar, step, TICK_HZ, type InputSource, type SimContext, type WorldState } from '../sim';
import { drawMask, drawTrackData, drawWalls, drawWheels } from './debug-draw';
import { KeyboardInput } from './input/keyboard';
import { startLoop } from './loop';
import { Renderer } from './render';
import { getTrackJson, loadImage, loadMask, loadOverhead, simContext, siteUrl, surfaces, type MaskState } from './track-loader';
import './style.css';

const TRACK_ID = 'indiana';

async function main(): Promise<void> {
  const json = getTrackJson(TRACK_ID);
  const [background, carSprite, initialMask, initialOverhead] = await Promise.all([
    loadImage(siteUrl(json.files.background)),
    loadImage(siteUrl('assets/Cars/blueCar.jpg')), // placeholder; livery card replaces sprites
    loadMask(json),
    loadOverhead(json),
  ]);
  let mask: MaskState = initialMask;
  let overhead = initialOverhead;
  let ctx: SimContext = simContext(mask.track);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, mask.track.mask.width, mask.track.mask.height, background, carSprite);

  const keyboard = new KeyboardInput();
  const drivers: InputSource[] = [keyboard];

  let prev: WorldState = createWorld(ctx, drivers.length);
  let curr: WorldState = prev;
  let debug = false;
  let fps = 0;

  keyboard.onAction((a) => {
    if (a.type === 'reset') {
      curr = resetCar(curr, 0, json.spawn, ctx);
      prev = curr;
    } else if (a.type === 'toggleDebug') {
      debug = !debug;
    }
    // gridSlot: no grid until card 06.
  });

  // Dev-only editor at ?edit=1. Dynamic import keeps it out of the production bundle.
  const editor = import.meta.env.DEV && new URLSearchParams(location.search).has('edit')
    ? new (await import('./editor/editor')).TrackEditor(renderer, json)
    : undefined;

  // Hot reload: Justin saves mask.png in an image editor, the running game picks it up.
  if (import.meta.hot) {
    import.meta.hot.on('track:file-changed', async ({ id, file }: { id: string; file: string }) => {
      if (id !== json.id) return;
      if (file === json.files.mask || (file === json.files.maskDraft && mask.file !== json.files.mask)) {
        try {
          mask = await loadMask(json);
          ctx = simContext(mask.track);
          console.info(`[track] hot-reloaded ${id}/${mask.file}`);
        } catch (e) {
          console.error('[track] mask reload failed', e);
        }
      } else if (file === json.files.overhead) {
        overhead = await loadOverhead(json);
      }
    });
  }

  startLoop({
    tick() {
      const inputs = drivers.map((d) => d.read(curr.tick));
      prev = curr;
      curr = step(curr, inputs, ctx);
      for (const e of curr.events) {
        if (e.type === 'outOfBounds')
          console.warn(`[mask bug] car ${e.car} reached out-of-bounds at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) in ${mask.file}; reset to spawn`);
      }
    },
    render(alpha, frameSeconds) {
      if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.05;
      const lw = renderer.trackPxPerCssPx();
      const car = curr.cars[0];
      const text = debug && car
        ? `tick ${curr.tick} @ ${TICK_HZ} Hz   fps ${fps.toFixed(0)}\n` +
          `x ${car.x.toFixed(1)} y ${car.y.toFixed(1)} hdg ${car.heading.toFixed(2)}\n` +
          `kph ${((car.speed / json.pxPerMeter) * 3.6).toFixed(0)}${car.inPitLane ? '  PIT LIMITER' : ''}${car.inPitBox ? '  PIT BOX' : ''}${car.offTrack ? '  OFF TRACK' : ''}\n` +
          `FL ${surfaces[car.surfaces[0]]!.id}  FR ${surfaces[car.surfaces[1]]!.id}\n` +
          `RL ${surfaces[car.surfaces[2]]!.id}  RR ${surfaces[car.surfaces[3]]!.id}\n` +
          `mask ${mask.file}  walls ${mask.walls.length}`
        : undefined;
      renderer.draw(prev, curr, alpha, {
        underCars: (c) => {
          if (editor) drawMask(c, mask.canvas, editor.maskOpacity);
          else if (debug) drawMask(c, mask.canvas, 0.5);
        },
        overCars: (c) => {
          if (overhead) c.drawImage(overhead, 0, 0, renderer.trackWidth, renderer.trackHeight);
        },
        overlay: (c) => {
          if (debug || editor) {
            drawWalls(c, mask.walls, lw);
            if (!editor) drawTrackData(c, json, lw);
            drawWheels(c, prev, curr, alpha, ctx.carGeometry, json.pxPerMeter, lw);
          }
          editor?.draw(c, lw);
        },
        text,
      });
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});
