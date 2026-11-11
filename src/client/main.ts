import kinematics from '../../config/placeholder-kinematics.json';
import indiana from '../../tracks/indiana.json';
import { createWorld, resetCar, step, TICK_HZ, type InputSource, type WorldState } from '../sim';
import { KeyboardInput } from './input/keyboard';
import { startLoop } from './loop';
import { Renderer } from './render';
import './style.css';

const asset = (path: string): string => `${import.meta.env.BASE_URL}${path}`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

async function main(): Promise<void> {
  const track = indiana;
  const [background, carSprite] = await Promise.all([
    loadImage(asset(track.background)),
    loadImage(asset('assets/Cars/blueCar.jpg')), // placeholder; livery card replaces sprites
  ]);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, track.width, track.height, background, carSprite);

  const keyboard = new KeyboardInput();
  const drivers: InputSource[] = [keyboard];

  let prev: WorldState = createWorld(track, drivers.length);
  let curr: WorldState = prev;
  let debug = false;
  let fps = 0;

  keyboard.onAction((a) => {
    if (a.type === 'reset') {
      curr = resetCar(curr, 0, track.spawn);
      prev = curr;
    } else if (a.type === 'toggleDebug') {
      debug = !debug;
    }
    // gridSlot: no grid until card 06.
  });

  startLoop({
    tick() {
      const inputs = drivers.map((d) => d.read(curr.tick));
      prev = curr;
      curr = step(curr, inputs, kinematics);
    },
    render(alpha, frameSeconds) {
      if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.05;
      const car = curr.cars[0];
      const text = debug && car
        ? `tick ${curr.tick} @ ${TICK_HZ} Hz\nfps ${fps.toFixed(0)}  alpha ${alpha.toFixed(2)}\n` +
          `x ${car.x.toFixed(1)} y ${car.y.toFixed(1)}\nhdg ${car.heading.toFixed(2)} spd ${car.speed.toFixed(1)}`
        : undefined;
      renderer.draw(prev, curr, alpha, text);
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});
