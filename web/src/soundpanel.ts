// The sound controls: music and effects switches, plus overall, music and effects volume.

import { audio } from './audio';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function mountSoundPanel(host: HTMLElement): void {
  const syncs: (() => void)[] = [];
  const root = h('div', 'snd');

  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLLabelElement => {
    const box = h('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => {
      audio.unlock();
      set(box.checked);
    });
    const wrap = h('label', 'snd-check');
    wrap.append(box, ` ${label}`);
    syncs.push(() => (box.checked = get()));
    return wrap;
  };

  // overall, music and effects levels: three sliders, each remembered per player
  // a slider greys out and locks while the thing it controls is switched off
  const slider = (label: string, key: 'volume' | 'musicVolume' | 'sfxVolume', active: () => boolean, onRelease?: () => void): HTMLLabelElement => {
    const input = h('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.addEventListener('input', () => {
      audio.unlock();
      audio.set({ [key]: Number(input.value) / 100 });
    });
    if (onRelease) input.addEventListener('change', onRelease); // let them hear where it landed
    const row = h('label', 'snd-slider');
    row.append(h('span', '', label), input);
    syncs.push(() => {
      input.value = String(Math.round(audio.settings[key] * 100));
      input.disabled = !active();
      row.classList.toggle('off', !active());
    });
    return row;
  };

  const switches = h('div', 'snd-switches');
  switches.append(
    toggle('Music', () => audio.settings.music, (v) => audio.set({ music: v })),
    toggle('Sound effects', () => audio.settings.sfx, (v) => audio.set({ sfx: v })),
  );
  const sliders = h('div', 'snd-sliders');
  sliders.append(
    slider('Volume', 'volume', () => audio.settings.music || audio.settings.sfx),
    slider('Music', 'musicVolume', () => audio.settings.music),
    slider('Effects', 'sfxVolume', () => audio.settings.sfx, () => audio.sfx('coin', 0, undefined, 1, true)),
  );
  root.append(switches, sliders);
  host.replaceChildren(root);

  const sync = (): void => syncs.forEach((fn) => fn());
  audio.subscribe(sync);
  sync();
}
