import './style.css';
import {
  MAX_COMP_PLAYERS,
  MAX_HEAT,
  MAX_OPTIONS,
  MAX_OPTION_LEN,
  SNAILS,
  SNAIL_COUNT,
  type ClientMsg,
  type CompView,
  type DecisionView,
  type Mode,
  type PlayerView,
  type ServerMsg,
  type StateMsg,
  type UpgradeKey,
} from './protocol';
import { TrackRenderer } from './renderer';

// ---- tiny DOM helpers ---------------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; style?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.style) e.setAttribute('style', props.style);
  e.append(...kids);
  return e;
}

const dot = (lane: number) => el('span', { class: 'dot', style: `background:${SNAILS[lane]!.color}` });
const laneLabel = (lane: number) => `#${lane + 1} ${SNAILS[lane]!.name}`;

// ---- state ----------------------------------------------------------------------

interface Session {
  code: string;
  token: string;
  name: string;
}

const SESSION_KEY = 'snail-session'; // per-tab, so two tabs can be two test players
let session: Session | null = loadSession();
let view: StateMsg | null = null;
let clockOffset = 0; // server time minus local time
let ws: WebSocket | null = null;
let retry = 0;
let bootId: string | null = null;
let inGame = false;
let hasRace = false;
let lastRound = -1;
let draftPick: number | null = null;
let pendingAdd: string | null = null; // decision mode: a snail name sent but not yet confirmed

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  session = s;
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session just won't survive a refresh */
  }
}

const renderer = new TrackRenderer($<HTMLCanvasElement>('track'));
renderer.onFinish = () => render();

// ---- networking -----------------------------------------------------------------

function send(msg: ClientMsg): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    toast('Not connected yet, one moment…');
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    $('offline').hidden = true;
    if (session) send({ type: 'join', code: session.code, name: session.name, token: session.token });
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as ServerMsg);
  ws.onclose = () => {
    if (inGame) $('offline').hidden = false;
    setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
  };
}

function onMessage(m: ServerMsg): void {
  switch (m.type) {
    case 'hello':
      // the server restarted since this page loaded: fetch the new build (the saved session is kept)
      if (bootId !== null && bootId !== m.boot) location.reload();
      bootId = m.boot;
      break;
    case 'joined':
      saveSession({ code: m.code, token: m.token, name: m.name });
      inGame = true;
      $('home').hidden = true;
      $('game').hidden = false;
      break;
    case 'similar':
      pendingAdd = m.name;
      $('similar-text').textContent = `Your snail \u201c${m.name}\u201d looks like \u201c${m.match}\u201d [close match]. Add it anyway?`;
      $('similar-box').hidden = false;
      break;
    case 'error':
      if (pendingAdd !== null) {
        $<HTMLInputElement>('snail-name').value = pendingAdd;
        pendingAdd = null;
      }
      if (inGame) toast(m.message);
      else {
        // a stale saved session (server restarted, room gone) lands here
        saveSession(null);
        $('home-error').textContent = m.message;
      }
      break;
    case 'race':
      hasRace = true;
      renderer.startRace({
        frames: m.frames,
        fps: m.fps,
        startLocal: Date.now() + (m.startAt - m.serverNow),
        order: m.order,
        labels: m.labels ?? null,
        events: m.events,
      });
      render();
      break;
    case 'state':
      if ($('similar-box').hidden) pendingAdd = null; // the add went through (or was never sent)
      view = m;
      clockOffset = m.serverNow - Date.now();
      render();
      break;
  }
}

// ---- home screen ----------------------------------------------------------------

const remembered = localStorage.getItem('snail-name') ?? '';
$<HTMLInputElement>('join-name').value = remembered;
$<HTMLInputElement>('create-name').value = remembered;
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $<HTMLInputElement>('join-code').value = urlCode.toUpperCase().slice(0, 6);

function rememberName(name: string): void {
  try {
    localStorage.setItem('snail-name', name);
  } catch {
    /* ignore */
  }
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('join-name').value.trim();
  rememberName(name);
  $('home-error').textContent = '';
  saveSession(null);
  send({ type: 'join', code: $<HTMLInputElement>('join-code').value.trim().toUpperCase(), name });
});

const modeSelect = $<HTMLSelectElement>('create-mode');
const roundsInput = $<HTMLInputElement>('create-rounds');
const timerInput = $<HTMLInputElement>('create-timer');
let roundsEdited = false;
let timerEdited = false;
roundsInput.addEventListener('input', () => (roundsEdited = true));
timerInput.addEventListener('input', () => (timerEdited = true));
function syncMode(): void {
  const decision = modeSelect.value === 'decision';
  const comp = modeSelect.value === 'competitive';
  $('classic-opts').hidden = decision;
  $('decision-note').hidden = !decision;
  $('comp-note').hidden = !comp;
  $('coins-label').hidden = comp;
  $('rounds-label').textContent = comp ? 'Seeding rounds' : 'Rounds';
  $('timer-label').textContent = comp ? 'Shop timer (s)' : 'Bet timer (s)';
  if (!roundsEdited) roundsInput.value = comp ? '6' : '5';
  if (!timerEdited) timerInput.value = comp ? '45' : '30';
}
modeSelect.addEventListener('change', syncMode);
syncMode();

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('create-name').value.trim();
  rememberName(name);
  $('home-error').textContent = '';
  saveSession(null);
  send({
    type: 'create',
    name,
    settings: {
      rounds: Number($<HTMLInputElement>('create-rounds').value),
      startCoins: Number($<HTMLInputElement>('create-coins').value),
      betSeconds: Number($<HTMLInputElement>('create-timer').value),
      mode: $<HTMLSelectElement>('create-mode').value as Mode,
      maxBet: Number($<HTMLInputElement>('create-maxbet').value),
      maxBetPct: $<HTMLSelectElement>('create-maxbet-type').value === 'pct',
    },
  });
});

// ---- game screen ------------------------------------------------------------------

const PANELS = ['lobby', 'snails', 'betting', 'shop', 'racing', 'results', 'final', 'cresults', 'dheat', 'dfinal'] as const;

function showPanel(name: (typeof PANELS)[number]): void {
  for (const p of PANELS) $(`panel-${p}`).hidden = p !== name;
}

function me(v: StateMsg): PlayerView {
  return v.players.find((p) => p.id === v.me)!;
}

const isHost = (v: StateMsg) => v.me === v.hostId;

const isDecision = (v: StateMsg) => v.settings.mode === 'decision';
const isComp = (v: StateMsg) => v.settings.mode === 'competitive';

const optionName = (d: DecisionView, id: number) => d.options.find((o) => o.id === id)?.name ?? '?';
const laneNames = (d: DecisionView) => (d.lanes ?? []).map((id) => optionName(d, id));
const playerName = (v: StateMsg, id: string) => v.players.find((p) => p.id === id)?.name ?? '?';

// the name on each lane of the heat in view, or null when lanes are just numbered (classic)
function currentLaneNames(v: StateMsg): string[] | null {
  if (v.comp?.lanes) return v.comp.lanes.map((id) => playerName(v, id));
  return v.decision?.lanes ? laneNames(v.decision) : null;
}

function render(): void {
  const v = view;
  if (!v) return;
  rebuildPicks(currentLaneNames(v));
  const c = isComp(v) ? v.comp : undefined;
  const compSeed = c?.stage === 'seed';
  // decision mode always has the bracket view; competitive only once elimination starts
  const d = isDecision(v) || c?.stage === 'elim' ? v.decision : undefined;

  if (v.round !== lastRound) {
    // new round (or heat): snails back to the line, bet draft restored from the server (page refresh) or cleared
    lastRound = v.round;
    hasRace = false;
    const names = currentLaneNames(v);
    if (names) renderer.reset(names.length, names);
    else renderer.reset();
    draftPick = v.myBet?.snail ?? null;
    $<HTMLInputElement>('amount').value = v.myBet ? String(v.myBet.amount) : '';
  }
  if (!hasRace) {
    if (d?.result && d.lanes && (v.phase === 'results' || v.phase === 'final')) {
      const lanes = d.lanes;
      renderer.parkPodium(d.result.order.map((id) => lanes.indexOf(id)), laneNames(d));
    } else if (compSeed && v.phase === 'results' && c?.result) {
      renderer.parkPodium(c.result.map((row) => row.lane), currentLaneNames(v));
    } else if (v.phase === 'results' && v.results) renderer.parkPodium(v.results.order);
  }
  $('track').hidden = (!!d && (v.phase === 'lobby' || v.phase === 'snails')) || (!!c && v.phase === 'shop');

  $('code-btn').textContent = v.code;
  $('round-label').textContent = roundLabel(v, d, c);
  const heatFinal = !!d && d.heats === 1;
  renderer.setAdvance(d && d.lanes && !heatFinal ? Math.min(4, d.lanes.length - 1) : null);
  renderer.setSelected(v.phase === 'betting' ? draftPick : null);
  const youLane = c ? (c.lanes ?? []).indexOf(v.me) : -1;
  renderer.setMarks(youLane >= 0 ? youLane : null, v.myBet ? v.myBet.snail : null);
  renderBoard(v);

  // keep showing the race until its animation has played out, even if the server already moved on
  const phase = (v.phase === 'results' || v.phase === 'final') && renderer.running ? 'racing' : v.phase;
  const panel = compSeed && phase === 'results' ? 'cresults' : d && phase === 'results' ? 'dheat' : d && phase === 'final' ? 'dfinal' : phase;
  showPanel(panel);
  if (phase !== 'snails') $('similar-box').hidden = true;
  if (phase === 'lobby') renderLobby(v);
  else if (phase === 'snails') renderSnails(v, d!);
  else if (phase === 'betting') renderBetting(v);
  else if (phase === 'shop') renderShop(v, c!);
  else if (phase === 'racing') {
    renderYou(v);
    $('racing-pool-line').hidden = !!d || !!c;
    if (compSeed) renderCompRacing(v, c!);
    else if (d) renderDecisionRacing(v, d);
    else $('racing-pool').textContent = String(v.pools.reduce((a, b) => a + b, 0));
  } else if (phase === 'results') {
    if (compSeed) renderCompResults(v, c!);
    else if (d) renderHeatResults(v, d);
    else renderResults(v);
  } else if (d) renderDecisionFinal(v, d);
  else renderFinal(v);
}

function roundLabel(v: StateMsg, d: DecisionView | undefined, c: CompView | undefined): string {
  if (c?.stage === 'seed') {
    if (c.finalShop) return 'Final shop';
    const seeding = `Seeding ${c.round} / ${c.rounds}`;
    return v.phase === 'shop' ? `${seeding} \u00b7 Shop` : `${seeding} \u00b7 Heat ${c.heat} / ${c.heats}`;
  }
  if (d) {
    if (v.phase === 'lobby') return 'Lobby';
    if (v.phase === 'snails') return 'Add snails';
    const final = d.heats === 1 && d.round === d.rounds;
    const prefix = c ? 'Elimination ' : '';
    return final ? 'Final' : `${prefix}Round ${d.round} / ${d.rounds} \u00b7 Heat ${d.heat} / ${d.heats}`;
  }
  return v.round > 0 ? `Round ${v.round} / ${v.settings.rounds}` : 'Lobby';
}

function renderBoard(v: StateMsg): void {
  const decision = isDecision(v);
  const comp = isComp(v);
  const seeded = comp && v.comp?.stage === 'elim';
  const sorted = decision
    ? [...v.players]
    : seeded
      ? [...v.players].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
      : comp
        ? [...v.players].sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.coins - a.coins)
        : [...v.players].sort((a, b) => b.coins - a.coins);
  $('board-title').textContent = decision ? 'Players' : comp ? (seeded ? 'Seeds' : 'Standings') : 'Leaderboard';
  const detail = (p: PlayerView) => (decision ? snailCountLabel(v, p.id) : seeded ? `${p.coins}` : comp ? `${p.points ?? 0} pts \u00b7 ${p.coins}` : String(p.coins));
  $('board').replaceChildren(
    ...sorted.map((p, i) =>
      el(
        'li',
        { class: [p.id === v.me ? 'me' : '', p.connected ? '' : 'off'].join(' ').trim() },
        el('span', { text: `${i + 1}.` }),
        el('span', { class: 'name', text: p.name + (p.id === v.hostId ? ' ★' : '') }),
        el('span', { class: 'tick', text: (v.phase === 'betting' || v.phase === 'shop') && p.ready ? '✓' : '' }),
        el('span', { class: 'coins', text: detail(p) }),
      ),
    ),
  );
}

function snailCountLabel(v: StateMsg, playerId: string): string {
  const n = v.decision?.options.filter((o) => o.by === playerId).length ?? 0;
  return n > 0 ? `${n} \ud83d\udc0c` : '';
}

function renderLobby(v: StateMsg): void {
  $('lobby-code').textContent = v.code;
  $('lobby-note').textContent = isDecision(v)
    ? 'Share the code or tap it above to copy an invite link. Everyone adds their options next, then the snails race to decide.'
    : isComp(v)
      ? `Share the code or tap it above to copy an invite link. Everyone gets their own snail (up to ${MAX_COMP_PLAYERS} players): ${v.settings.rounds} seeding round${v.settings.rounds === 1 ? '' : 's'}, then elimination.`
      : 'Share the code or tap it above to copy an invite link. Nobody can join once the first round of betting starts.';
  const host = isHost(v);
  $('start-btn').hidden = !host;
  $('lobby-wait').hidden = host;
}

// ---- decision mode --------------------------------------------------------------------

// rounds (including the final) needed for n snails: heats of up to MAX_HEAT, top 4 of each advance
function bracketRounds(n: number): number {
  let rounds = 1;
  while (n > MAX_HEAT) {
    const heats = Math.ceil(n / MAX_HEAT);
    const base = Math.floor(n / heats);
    const extra = n % heats;
    let next = 0;
    for (let h = 0; h < heats; h++) next += Math.min(4, base + (h < extra ? 1 : 0) - 1);
    n = next;
    rounds++;
  }
  return rounds;
}

const snailInput = $<HTMLInputElement>('snail-name');
snailInput.maxLength = MAX_OPTION_LEN;

$('snail-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = snailInput.value.trim();
  if (!name) return;
  $('similar-box').hidden = true;
  pendingAdd = name;
  if (send({ type: 'addSnail', name })) snailInput.value = '';
  else pendingAdd = null;
  snailInput.focus();
});
$('similar-yes').addEventListener('click', () => {
  if (pendingAdd !== null) send({ type: 'addSnail', name: pendingAdd, force: true });
  $('similar-box').hidden = true;
  pendingAdd = null;
  snailInput.focus();
});
$('similar-no').addEventListener('click', () => {
  if (pendingAdd !== null) snailInput.value = pendingAdd;
  $('similar-box').hidden = true;
  pendingAdd = null;
  snailInput.focus();
});
$('begin-btn').addEventListener('click', () => send({ type: 'begin' }));

function renderSnails(v: StateMsg, d: DecisionView): void {
  const n = d.options.length;
  const host = isHost(v);
  $('snail-count').textContent = `${n} / ${MAX_OPTIONS} snails`;
  snailInput.disabled = n >= MAX_OPTIONS;
  $('snail-list').replaceChildren(
    ...d.options.map((o) => {
      const mine = o.by === v.me;
      const row = el('li', {}, el('span', { class: 'sname', text: o.name }), el('span', { class: 'by', text: mine ? 'you' : o.byName }));
      if (mine || host) {
        const x = el('button', { class: 'x', text: '\u00d7' });
        x.type = 'button';
        x.title = `Remove ${o.name}`;
        x.addEventListener('click', () => send({ type: 'removeSnail', id: o.id }));
        row.append(x);
      }
      return row;
    }),
  );
  $('begin-row').hidden = !host;
  const begin = $<HTMLButtonElement>('begin-btn');
  begin.disabled = n < 2;
  begin.textContent = n < 2 ? 'Add at least 2 snails' : 'Start racing';
  $('bracket-note').textContent =
    n < 2
      ? ''
      : n <= MAX_HEAT
        ? `${n} snails: one race decides it.`
        : `${n} snails: ${Math.ceil(n / MAX_HEAT)} heats to start, top 4 of each move on, ${bracketRounds(n)} rounds in all.`;
  $('snails-wait').hidden = host;
}

function renderDecisionRacing(v: StateMsg, d: DecisionView): void {
  const final = d.heats === 1 && d.round === d.rounds;
  $('racing-title').textContent = final ? 'The final' : `Round ${d.round} of ${d.rounds}, heat ${d.heat} of ${d.heats}`;
  const seedOf = (id: number) => {
    const owner = isComp(v) ? v.players.find((p) => p.id === d.options.find((o) => o.id === id)?.by) : undefined;
    return owner?.seed ? ` (seed ${owner.seed})` : '';
  };
  const lineup = (d.lanes ?? []).map((id, lane) => el('span', { class: 'lineup' }, dot(lane), optionName(d, id) + seedOf(id)));
  $('racing-line').replaceChildren(...lineup);
}

const ORD = ['1st', '2nd', '3rd'];
const ordinal = (n: number) => ORD[n - 1] ?? `${n}th`;

function renderHeatResults(v: StateMsg, d: DecisionView): void {
  const r = d.result;
  if (!r) return;
  const lanes = d.lanes ?? [];
  $('dheat-title').textContent = `${r.advance} snails move on`;
  $('dheat-note').textContent = `Round ${d.round} of ${d.rounds}, heat ${d.heat} of ${d.heats}. The top ${r.advance} of ${r.order.length} move on.`;
const c = isComp(v) ? v.comp : undefined;
  const prizeOf = (lane: number) => c?.result?.find((row) => row.lane === lane)?.prize ?? 0;
  const head = el('tr', {}, el('th', { text: isComp(v) ? 'Player' : 'Snail' }), ...(c ? [el('th', { class: 'num', text: 'Prize' })] : []), el('th', { text: '' }));
  const rows = r.order.map((id, i) =>
    el(
      'tr',
      { class: i < r.advance ? 'adv' : 'out' },
      el('td', {}, dot(lanes.indexOf(id)), optionName(d, id)),
      ...(c ? [el('td', { class: 'num', text: prizeOf(lanes.indexOf(id)) ? `+${prizeOf(lanes.indexOf(id))}` : '\u2014' })] : []),
      el('td', { class: 'num', text: i < r.advance ? 'Advances' : 'Out' }),
    ),
  );
  $('dheat-table').replaceChildren(head, ...rows);
  const bets = c?.bets ?? [];
  $('dheat-bets-note').hidden = bets.length === 0;
  $('dheat-bets').hidden = bets.length === 0;
  $('dheat-bets').replaceChildren(
    ...bets.map((b) => {
      const net = b.payout - b.amount;
      return el(
        'tr',
        {},
        el('td', { text: b.name + (b.id === v.me ? ' (you)' : '') }),
        el('td', { text: `${b.amount} on ${optionName(d, lanes[b.lane] ?? -1)}` }),
        el('td', { class: `num ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}`, text: net > 0 ? `+${net}` : String(net) }),
      );
    }),
  );
  const host = isHost(v);
  const next = $<HTMLButtonElement>('dnext-btn');
  next.hidden = !host;
  next.textContent = d.heat < d.heats ? 'Next heat' : 'Next round';
  $('dheat-wait').textContent = host ? '' : 'Waiting for the host to continue\u2026';
}

function renderDecisionFinal(v: StateMsg, d: DecisionView): void {
  const rows = d.standings ?? [];
  const winner = rows[0];
  const comp = isComp(v);
  $('dfinal-title').textContent = winner ? `${optionName(d, winner.option)} wins${comp ? ' the race' : ''}!` : 'Final standings';
  const rich = $('dfinal-rich');
  rich.hidden = !comp;
  if (comp) {
    const top = Math.max(...v.players.map((p) => p.coins));
    const richest = v.players.filter((p) => p.coins === top);
    const champ = d.options.find((o) => o.id === winner?.option)?.by;
    rich.textContent = `Richest: ${richest.map((p) => p.name).join(', ')} (${top} coins)` + (richest.some((p) => p.id === champ) ? ' \u2014 a double win!' : '');
  }
  const head = el('tr', {}, el('th', { text: 'Rank' }), el('th', { text: comp ? 'Player' : 'Snail' }), el('th', { text: 'Result' }), ...(comp ? [el('th', { class: 'num', text: 'Coins' })] : [el('th', { text: 'Added by' })]));
  const body = rows.map((s) => {
    const o = d.options.find((x) => x.id === s.option);
    const result = s.round === d.rounds ? `Final, ${ordinal(s.place)}` : `Out in round ${s.round} (${ordinal(s.place)} of ${s.size})`;
    return el(
      'tr',
      { class: s.rank === 1 ? 'adv' : '' },
      el('td', { text: ordinal(s.rank) }),
      el('td', { text: o?.name ?? '?' }),
      el('td', { text: result }),
      ...(comp ? [el('td', { class: 'num', text: String(v.players.find((p) => p.id === o?.by)?.coins ?? '') })] : [el('td', { text: o ? (o.by === v.me ? 'you' : o.byName) : '' })]),
    );
  });
  $('dfinal-table').replaceChildren(head, ...body);
  $('drematch-btn').hidden = !isHost(v);
}
$('dnext-btn').addEventListener('click', () => send({ type: 'next' }));
$('drematch-btn').addEventListener('click', () => send({ type: 'rematch' }));

// ---- competitive mode ----------------------------------------------------------------

const UPGRADES: { key: UpgradeKey; name: string; desc: string; max: number }[] = [
  { key: 'speed', name: 'Speed', desc: 'Faster the whole race', max: 5 },
  { key: 'determ', name: 'Determination', desc: 'Gets faster as the race goes on', max: 5 },
  { key: 'boost', name: 'Boost', desc: 'A burst of speed after passing a snail', max: 5 },
  { key: 'shell', name: 'Shell', desc: 'Blocks or shortens attacks against you', max: 5 },
  { key: 'salt', name: 'Salt', desc: 'Shots per race that slow a rival (the one ahead of you if you are behind)', max: 3 },
  { key: 'food', name: 'Food', desc: 'Shots per race that distract a rival (the leader if you are behind)', max: 3 },
];

$('ready-btn').addEventListener('click', () => send({ type: 'ready' }));
$('shop-close-btn').addEventListener('click', () => send({ type: 'close' }));

function renderShop(v: StateMsg, c: CompView): void {
  const self = me(v);
  const upg = self.upg;
  if (!upg) return;
  const spare = self.coins;
  const left = self.left ?? 0;
  const free = self.free ?? 0;
  $('shop-title').textContent = c.finalShop ? 'Final shop: last chance to upgrade' : `Seeding round ${c.round} of ${c.rounds}: shop`;
  $('shop-note').textContent =
    (self.bailout ? 'You were broke, so the house lent you 50 coins. ' : '') +
    (c.finalShop ? 'Seeds are locked in. Upgrades close for good once elimination starts. ' : '') +
    'Upgrades last the whole game and make your snail faster; nobody steers during the race. Everyone is paid for racing (a bit extra if you are behind on coins), and the top 60% of each heat share the prize pool. Last place gets a free upgrade next round. Players sitting out a heat can bet on it, and most coins at the end is a second way to win.';
  $('shop-coins').textContent = `${self.coins} coins · ${left} upgrade${left === 1 ? '' : 's'} left this round (one level per item)` + (free ? ' \u00b7 plus 1 FREE pick' : '');
  $('shop-items').replaceChildren(
    ...UPGRADES.map((u) => {
      const level = upg[u.key];
      const cost = c.unit * (level + 1);
      const buy = el('button', { class: 'chip', text: level >= u.max ? 'Maxed' : free ? 'Free' : `Buy ${cost}` });
      buy.type = 'button';
      buy.disabled = level >= u.max || !!self.bought?.includes(u.key) || (!free && (cost > spare || left <= 0));
      buy.addEventListener('click', () => send({ type: 'buy', item: u.key }));
      const pips = '\u25cf'.repeat(level) + '\u25cb'.repeat(u.max - level);
      return el('div', { class: 'shop-row' }, el('b', { text: u.name }), buy, el('span', { class: 'desc' }, el('span', { class: 'pips', text: pips }), ` ${u.desc}`));
    }),
  );
  const ready = $<HTMLButtonElement>('ready-btn');
  ready.textContent = self.ready ? 'Ready \u2713' : 'Ready';
  ready.disabled = self.ready;
  $('shop-close-btn').hidden = !isHost(v);
  const waiting = v.players.filter((p) => p.connected && !p.ready).length;
  $('shop-status').textContent = self.ready
    ? `You're ready. Waiting on ${waiting} player${waiting === 1 ? '' : 's'}.`
    : 'Press Ready when you are done shopping.';
  updateTimer();
}

// Which snail is yours and what you have riding on the heat, in words (the track flags the lanes).
function renderYou(v: StateMsg): void {
  const parts: string[] = [];
  const mine = isComp(v) ? (v.comp?.lanes ?? []).indexOf(v.me) : -1;
  if (mine >= 0) parts.push(`You are #${mine + 1}`);
  if (v.myBet) parts.push(`Your bet: ${v.myBet.amount} on ${laneText(v, v.myBet.snail)}`);
  $('racing-you').textContent = parts.join(' \u00b7 ');
  $('racing-you').hidden = parts.length === 0;
}

function renderCompRacing(v: StateMsg, c: CompView): void {
  $('racing-title').textContent = `Seeding round ${c.round} of ${c.rounds}, heat ${c.heat} of ${c.heats}`;
  $('racing-line').replaceChildren(
    ...(c.lanes ?? []).map((id, lane) => el('span', { class: 'lineup' }, dot(lane), playerName(v, id) + (id === v.me ? ' (you)' : ''))),
  );
}

function renderCompResults(v: StateMsg, c: CompView): void {
  const rows = c.result ?? [];
  const winner = rows[0];
  $('cres-title').textContent = winner ? `${winner.name} wins the heat!` : 'Heat over';
  const bets = c.bets ?? [];
  $('cres-bets-note').hidden = bets.length === 0;
  $('cres-bets').hidden = bets.length === 0;
  $('cres-bets').replaceChildren(
    ...bets.map((b) => {
      const net = b.payout - b.amount;
      const snail = rows.find((r) => r.lane === b.lane);
      return el(
        'tr',
        {},
        el('td', { text: b.name + (b.id === v.me ? ' (you)' : '') }),
        el('td', { text: `${b.amount} on ${snail?.name ?? '?'}` }),
        el('td', { class: `num ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}`, text: net > 0 ? `+${net}` : String(net) }),
      );
    }),
  );
  $('cres-note').textContent =
    `Seeding round ${c.round} of ${c.rounds}, heat ${c.heat} of ${c.heats}. Points go 8, 7, 6\u2026 by finish; the top ${rows.filter((r) => r.prize > 0).length} share the prize pool and everyone gets paid for racing.`;
  const head = el('tr', {}, el('th', { text: 'Place' }), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Pts' }), el('th', { class: 'num', text: 'Coins' }));
  $('cres-table').replaceChildren(
    head,
    ...rows.map((r) => {
      return el(
        'tr',
        { class: r.id === v.me ? 'adv' : '' },
        el('td', { text: ordinal(r.place) }),
        el('td', { text: r.name + (r.id === v.me ? ' (you)' : '') + (r.consolation ? ' \u00b7 free upgrade next' : '') }),
        el('td', { class: 'num', text: `+${r.points}` }),
        el('td', { class: `num ${r.base + r.prize ? 'gain' : ''}`, text: r.base + r.prize ? `+${r.base + r.prize}` : '\u2014' }),
      );
    }),
  );
  const standings = [...v.players].sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.coins - a.coins);
  $('cstand-table').replaceChildren(
    el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Pts' }), el('th', { class: 'num', text: 'Coins' })),
    ...standings.map((p, i) =>
      el('tr', {}, el('td', { text: String(i + 1) }), el('td', { text: p.name + (p.id === v.me ? ' (you)' : '') }), el('td', { class: 'num', text: String(p.points ?? 0) }), el('td', { class: 'num', text: String(p.coins) })),
    ),
  );
  const host = isHost(v);
  const next = $<HTMLButtonElement>('cnext-btn');
  next.hidden = !host;
  next.textContent = c.heat < c.heats ? 'Next heat' : c.round < c.rounds ? 'Next round' : 'Final shop';
  $('cres-wait').textContent = host ? '' : 'Waiting for the host to continue\u2026';
}
$('cnext-btn').addEventListener('click', () => send({ type: 'next' }));

// What one coin on `lane` would return if it wins, given everyone else's bets plus this bet.
function multiplier(v: StateMsg, lane: number, amount: number): number {
  const mine = v.myBet;
  const pool = v.pools.reduce((a, b) => a + b, 0) - (mine?.amount ?? 0);
  const lanePool = (v.pools[lane] ?? 0) - (mine?.snail === lane ? mine.amount : 0);
  return (pool + amount) / (lanePool + amount);
}

let pickButtons: HTMLButtonElement[] = [];
let pickSig: string | null = null;

// one button per snail in the heat: numbered colour names in classic, player names in competitive
function rebuildPicks(labels: string[] | null): void {
  const sig = labels ? labels.join('|') : '';
  if (pickSig === sig) return;
  pickSig = sig;
  pickButtons = [];
  for (let i = 0; i < (labels?.length ?? SNAIL_COUNT); i++) {
    const b = el(
      'button',
      { class: 'pick', style: `border-left-color:${SNAILS[i]!.color}` },
      el('b', { text: labels ? `#${i + 1} ${labels[i]}` : laneLabel(i) }),
      el('span', { class: 'info' }),
      el('span', { class: 'pays' }),
    );
    b.type = 'button';
    b.addEventListener('click', () => {
      draftPick = i;
      if (view) renderBetting(view);
      renderer.setSelected(i);
    });
    pickButtons.push(b);
  }
  $('snail-picks').replaceChildren(...pickButtons);
}

const amountInput = $<HTMLInputElement>('amount');
amountInput.addEventListener('input', () => view && renderBetting(view));
document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    if (!view) return;
    amountInput.value = String(Math.max(1, Math.floor(betLimit(view) * Number(c.dataset.frac))));
    renderBetting(view);
  }),
);

const laneText = (v: StateMsg, lane: number) => {
  const names = currentLaneNames(v);
  return names ? `#${lane + 1} ${names[lane] ?? '?'}` : laneLabel(lane);
};
$('skip-btn').addEventListener('click', () => send({ type: 'ready' }));

// mirrors Settings.betLimit in game.go
function betLimit(v: StateMsg): number {
  const { coins } = me(v);
  const { maxBet, maxBetPct } = v.settings;
  if (maxBet <= 0) return coins;
  return maxBetPct ? Math.min(coins, Math.max(Math.min(1, coins), Math.floor((coins * maxBet) / 100))) : Math.min(coins, maxBet);
}

function currentAmount(): number {
  const n = Math.floor(Number(amountInput.value));
  return Number.isFinite(n) ? n : 0;
}

function renderBetting(v: StateMsg): void {
  const self = me(v);
  const comp = isComp(v);
  const racing = comp && !!v.comp?.lanes?.includes(v.me);
  $('betting-title').textContent = racing ? 'Your snail is up' : 'Place your bets';
  $('snail-picks').hidden = racing;
  $('bet-amount-row').hidden = racing;
  $('bet-btn').hidden = racing;
  $('skip-btn').hidden = !comp || racing || !!v.myBet;
  const amount = currentAmount();
  const validAmount = amount >= 1 && amount <= betLimit(v);
  const preview = Math.max(1, validAmount ? amount : 1);

  amountInput.max = String(betLimit(v));
  $('bailout-note').hidden = !self.bailout;
  if (self.bailout) $('bailout-note').textContent = 'You were broke, so the house lent you 50 coins. Spend them wisely.';

  pickButtons.forEach((b, i) => {
    b.setAttribute('aria-pressed', String(draftPick === i));
    const backers = v.backers[i] ?? 0;
    b.querySelector('.info')!.textContent = `${backers} backer${backers === 1 ? '' : 's'} · ${v.pools[i] ?? 0} coins`;
    const x = multiplier(v, i, preview);
    b.querySelector('.pays')!.textContent = x <= 1.001 ? 'pays ×1.00 (refund)' : `pays ×${x.toFixed(2)}`;
  });

  const betBtn = $<HTMLButtonElement>('bet-btn');
  betBtn.textContent = v.myBet ? 'Update bet' : 'Lock in bet';
  betBtn.disabled = draftPick === null || !validAmount;

  $('close-btn').hidden = !isHost(v);
  if (racing) {
    $('bet-status').textContent = `You are #${(v.comp?.lanes ?? []).indexOf(v.me) + 1}. ` + 'Your snail races this heat, so you can\'t bet on it. Everyone sitting out is placing bets now; you win prize money if you finish near the front.';
  } else if (comp && self.ready && !v.myBet) {
    $('bet-status').textContent = 'You\'re sitting this one out. Waiting on the other bettors.';
  } else if (v.myBet) {
    $('bet-status').textContent = `Locked in: ${v.myBet.amount} on ${laneText(v, v.myBet.snail)}. You can change it until betting closes.`;
  } else {
    $('bet-status').textContent = `You have ${self.coins} coins${v.settings.maxBet > 0 ? ` (max bet ${betLimit(v)})` : ''}. Pick a snail and an amount${comp ? ', or skip' : ''}.`;
  }
  updateTimer();
}

$('bet-btn').addEventListener('click', () => {
  if (draftPick !== null) send({ type: 'bet', snail: draftPick, amount: currentAmount() });
});
$('close-btn').addEventListener('click', () => send({ type: 'close' }));
$('start-btn').addEventListener('click', () => send({ type: 'start' }));
$('next-btn').addEventListener('click', () => send({ type: 'next' }));
$('rematch-btn').addEventListener('click', () => send({ type: 'rematch' }));

function renderResults(v: StateMsg): void {
  const r = v.results;
  if (!r) return;
  const title = $('winner-title');
  title.replaceChildren(dot(r.winner), `${laneLabel(r.winner)} wins!`);

  const paid = r.rows.filter((x) => x.place > 0).length;
  $('results-note').textContent =
    r.pool === 0
      ? 'Nobody bet this round.'
      : r.refunded
        ? 'Nobody backed the top 3, so every bet was refunded.'
        : `Pool of ${r.pool} coins shared by ${paid} podium backer${paid === 1 ? '' : 's'} (1st 60 / 2nd 25 / 3rd 15).`;

  const head = el('tr', {}, el('th', { text: 'Player' }), el('th', { text: 'Snail' }), el('th', { text: 'Place' }), el('th', { class: 'num', text: 'Bet' }), el('th', { class: 'num', text: 'Net' }));
  const rows = r.rows.map((x) => {
    const net = x.payout - x.amount;
    return el(
      'tr',
      {},
      el('td', { text: x.name + (x.id === v.me ? ' (you)' : '') }),
      el('td', {}, dot(x.snail), String(x.snail + 1)),
      el('td', { text: x.place ? ['1st', '2nd', '3rd'][x.place - 1]! : '—' }),
      el('td', { class: 'num', text: String(x.amount) }),
      el('td', { class: `num ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}`, text: net > 0 ? `+${net}` : String(net) }),
    );
  });
  $('results-table').replaceChildren(head, ...rows);

  const host = isHost(v);
  const last = v.round >= v.settings.rounds;
  const next = $<HTMLButtonElement>('next-btn');
  next.hidden = !host;
  next.textContent = last ? 'Final standings' : 'Next round';
  $('results-wait').textContent = host ? '' : 'Waiting for the host to continue…';
}

function renderFinal(v: StateMsg): void {
  const sorted = [...v.players].sort((a, b) => b.coins - a.coins);
  const ord = ['1st', '2nd', '3rd'];
  $('podium').replaceChildren(
    ...sorted.map((p, i) =>
      el('li', {}, el('span', { class: 'rank', text: ord[i] ?? `${i + 1}th` }), el('span', { class: 'name', text: p.name + (p.id === v.me ? ' (you)' : '') }), el('b', { text: String(p.coins) })),
    ),
  );
  $('rematch-btn').hidden = !isHost(v);
}

function updateTimer(): void {
  const t = $('timer');
  const open = view?.phase === 'betting' || view?.phase === 'shop';
  if (open && view?.deadline) {
    const left = Math.max(0, Math.ceil((view.deadline - (Date.now() + clockOffset)) / 1000));
    t.textContent = `${view.phase === 'shop' ? 'Shop' : 'Betting'} closes in ${left}s`;
  } else if (open && view) {
    const racing = view.phase === 'betting' ? (view.comp?.lanes ?? []) : [];
    const waiting = view.players.filter((p) => p.connected && !p.ready && !racing.includes(p.id)).length;
    t.textContent = `Waiting on ${waiting}`;
  } else {
    t.textContent = '';
  }
}
setInterval(updateTimer, 250);

// Forget this room and return to the home screen (closing the socket drops us from the room).
$('leave-btn').addEventListener('click', () => {
  const host = view && isHost(view);
  const msg = host ? 'Leave this game? Another player will take over as host.' : 'Leave this game?';
  if (!confirm(msg)) return;
  saveSession(null);
  location.href = location.pathname; // fresh page, no ?code= either
});

$('code-btn').addEventListener('click', async () => {
  if (!view) return;
  const link = `${location.origin}/?code=${view.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied', true);
  } catch {
    toast(link, true);
  }
});

let toastTimer = 0;
function toast(msg: string, good = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.style.background = good ? 'var(--good)' : 'var(--bad)';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 3500);
}

connect();
