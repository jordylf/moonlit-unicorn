import type { GuideId, World } from '../scene/World';

// The bottom guide: one chip per interaction. A chip lights up once its interaction
// has been discovered; pressing it performs the interaction (keyboard access to all).

const icon = (paths: string) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS: Record<GuideId, string> = {
  drag: icon('<path d="M8 1.5v13M1.5 8h13M8 1.5 6.3 3.2M8 1.5l1.7 1.7M8 14.5l-1.7-1.7M8 14.5l1.7-1.7M1.5 8l1.7-1.7M1.5 8l1.7 1.7M14.5 8l-1.7-1.7M14.5 8l-1.7 1.7"/>'),
  poke: icon('<circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="8" r="5.6" opacity=".55"/>'),
  star: icon('<path d="M8 1.8l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.1l-3.7 2 .8-4.1L2 6.1l4.2-.5z"/>'),
  sky: icon('<path d="M14.2 1.8 6.8 9.2"/><path d="M11 2.4 7 6.4" opacity=".5"/><circle cx="4.6" cy="11.4" r="2.4"/>'),
  wish: icon('<path d="M11.8 2.6a5.6 5.6 0 1 0 1.7 8.2 4.6 4.6 0 0 1-1.7-8.2z"/><path d="M13.2 1.6v2.2M12.1 2.7h2.2" opacity=".7"/>'),
  wind: icon('<path d="M1.5 6h8.2a2.2 2.2 0 1 0-2.2-2.2M1.5 10h10a2.2 2.2 0 1 1-2.2 2.2M1.5 8h5"/>'),
  zoom: icon('<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14.3 14.3M7 5v4M5 7h4"/>'),
};

type Item = { id: GuideId; mouse: string; touch: string; short: string; run: () => void };

const STORE_KEY = 'unicorn-guide-collapsed';

export class GuideBar {
  private readonly root = document.createElement('nav');
  private readonly chips = new Map<GuideId, { el: HTMLButtonElement; detail: HTMLElement }>();
  private readonly count = document.createElement('span');
  private readonly found = new Set<GuideId>();
  private readonly total: number;

  constructor(world: World) {
    const a = world.actions;
    const items: Item[] = [
      { id: 'drag', mouse: 'Drag the unicorn', touch: 'Drag the unicorn', short: 'Drag', run: a.dragDemo },
      { id: 'poke', mouse: 'Click the unicorn', touch: 'Tap the unicorn', short: 'Tap', run: a.poke },
      { id: 'star', mouse: 'Light the stars', touch: 'Light the stars', short: 'Stars', run: () => a.strikeStar() },
      { id: 'sky', mouse: 'Click the sky', touch: 'Tap the sky', short: 'Sky', run: () => a.shootingStar() },
      { id: 'wish', mouse: 'Hold to wish', touch: 'Press & hold', short: 'Hold', run: a.wishPulse },
      { id: 'wind', mouse: 'Swipe for wind', touch: 'Swipe for wind', short: 'Swipe', run: () => a.gust(Math.random() < 0.5 ? -1 : 1, 0.8) },
      { id: 'zoom', mouse: 'Scroll to zoom', touch: 'Pinch to zoom', short: 'Pinch', run: a.zoomStep },
    ];
    this.total = items.length;
    const touch = matchMedia('(pointer: coarse)').matches;

    this.root.className = 'guide';
    this.root.setAttribute('aria-label', 'Ways to interact');
    const toggle = document.createElement('button');
    toggle.className = 'guide-toggle';
    toggle.type = 'button';
    toggle.innerHTML = `<span class="guide-toggle-text">Guide</span>`;
    this.count.className = 'guide-count';
    toggle.append(this.count);

    const list = document.createElement('ul');
    list.className = 'guide-list';
    for (const it of items) {
      const li = document.createElement('li');
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'chip';
      const full = touch ? it.touch : it.mouse;
      el.title = `${full} (or press to try)`;
      el.setAttribute('aria-label', `${full}: try it`);
      el.innerHTML = `${ICONS[it.id]}<span class="chip-label" aria-hidden="true"><span class="long">${full}</span><span class="short">${it.short}</span></span>`;
      const detail = document.createElement('span');
      detail.className = 'chip-detail';
      if (it.id === 'star') detail.textContent = `0/${world.stars.total}`;
      el.append(detail);
      el.addEventListener('click', () => it.run());
      li.append(el);
      list.append(li);
      this.chips.set(it.id, { el, detail });
    }
    this.root.append(toggle, list);
    document.body.append(this.root);

    let collapsed = false;
    try {
      collapsed = localStorage.getItem(STORE_KEY) === '1';
    } catch {
      /* storage blocked: start expanded */
    }
    const setCollapsed = (c: boolean) => {
      this.root.classList.toggle('collapsed', c);
      toggle.setAttribute('aria-expanded', String(!c));
      toggle.setAttribute('aria-label', c ? 'Show the interaction guide' : 'Hide the interaction guide');
      try {
        localStorage.setItem(STORE_KEY, c ? '1' : '0');
      } catch {
        /* ignore */
      }
    };
    setCollapsed(collapsed);
    toggle.addEventListener('click', () => setCollapsed(!this.root.classList.contains('collapsed')));
    this.updateCount();

    world.onDiscover = (id, detail) => this.discover(id, detail);
  }

  show() {
    requestAnimationFrame(() => this.root.classList.add('visible'));
  }

  discover(id: GuideId, detail?: string) {
    const chip = this.chips.get(id);
    if (!chip) return;
    if (detail !== undefined) chip.detail.textContent = detail;
    chip.el.classList.remove('pulse');
    void chip.el.offsetWidth; // restart the pulse animation
    chip.el.classList.add('pulse');
    if (this.found.has(id)) return;
    this.found.add(id);
    chip.el.classList.add('done');
    this.updateCount();
  }

  private updateCount() {
    this.count.textContent = `${this.found.size}/${this.total}`;
  }
}
