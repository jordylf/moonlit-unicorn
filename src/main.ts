import { World } from './scene/World';
import { GuideBar } from './ui/GuideBar';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const loader = document.getElementById('loader')!;
const bar = loader.querySelector<HTMLElement>('.loader-bar')!;
const errorBox = document.getElementById('error')!;
const pct = loader.querySelector<HTMLElement>('.loader-pct')!;
const line = loader.querySelector<HTMLElement>('.loader-line')!;

// loader: a scatter of twinkling stars and a status line that changes while we wait
const stars = loader.querySelector<HTMLElement>('.loader-stars')!;
for (let i = 0; i < 46; i++) {
  const s = document.createElement('i');
  s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;--d:${2 + Math.random() * 3}s;--delay:${-Math.random() * 4}s`;
  stars.append(s);
}
const LINES = ['Waking the stars', 'Gathering the clouds', 'Combing the mane', 'Polishing the moon', 'Lighting the horn'];
let lineIndex = 0;
const lineTimer = window.setInterval(() => {
  line.classList.add('swap');
  window.setTimeout(() => {
    line.textContent = LINES[++lineIndex % LINES.length];
    line.classList.remove('swap');
  }, 500);
}, 1700);
const setProgress = (p: number) => {
  bar.style.transform = `scaleX(${p})`;
  pct.textContent = `${Math.round(p * 100)}%`;
};

function showError(err: unknown) {
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  errorBox.textContent = `Scene failed to start\n\n${msg}`;
  errorBox.hidden = false;
  loader.classList.add('done');
  clearInterval(lineTimer);
}

async function boot() {
  const world = new World(canvas);
  // download is most of the wait; shader warm-up is the rest
  await world.load((p) => setProgress(p * 0.85));
  setProgress(1);
  line.textContent = 'Ready';
  clearInterval(lineTimer);
  const guide = new GuideBar(world);
  world.start();
  loader.classList.add('done');
  window.setTimeout(() => guide.show(), 2600);
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
    const { createDebug } = await import('./scene/Debug');
    createDebug(world);
  }
}

boot().catch(showError);
