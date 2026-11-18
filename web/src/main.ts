import './style.css';
import {
  MAX_HEAT,
  MAX_OPTIONS,
  MAX_OPTION_LEN,
  SNAILS,
  SNAIL_COUNT,
  type ClientMsg,
  type DecisionView,
  type Mode,
  type PlayerView,
  type ServerMsg,
  type StateMsg,
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
function syncMode(): void {
  const decision = modeSelect.value === 'decision';
  $('classic-opts').hidden = decision;
  $('decision-note').hidden = !decision;
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
    },
  });
});

// ---- game screen ------------------------------------------------------------------

const PANELS = ['lobby', 'snails', 'betting', 'racing', 'results', 'final', 'dheat', 'dfinal'] as const;

function showPanel(name: (typeof PANELS)[number]): void {
  for (const p of PANELS) $(`panel-${p}`).hidden = p !== name;
}

function me(v: StateMsg): PlayerView {
  return v.players.find((p) => p.id === v.me)!;
}

const isHost = (v: StateMsg) => v.me === v.hostId;

const isDecision = (v: StateMsg) => v.settings.mode === 'decision';

const optionName = (d: DecisionView, id: number) => d.options.find((o) => o.id === id)?.name ?? '?';
const laneNames = (d: DecisionView) => (d.lanes ?? []).map((id) => optionName(d, id));

function render(): void {
  const v = view;
  if (!v) return;
  const d = isDecision(v) ? v.decision : undefined;

  if (v.round !== lastRound) {
    // new round (or heat): snails back to the line, bet draft restored from the server (page refresh) or cleared
    lastRound = v.round;
    hasRace = false;
    if (d?.lanes) renderer.reset(d.lanes.length, laneNames(d));
    else renderer.reset();
    draftPick = v.myBet?.snail ?? null;
    $<HTMLInputElement>('amount').value = v.myBet ? String(v.myBet.amount) : '';
  }
  if (!hasRace) {
    if (d?.result && d.lanes && (v.phase === 'results' || v.phase === 'final')) {
      const lanes = d.lanes;
      renderer.parkPodium(d.result.order.map((id) => lanes.indexOf(id)), laneNames(d));
    } else if (v.phase === 'results' && v.results) renderer.parkPodium(v.results.order);
  }
  $('track').hidden = !!d && (v.phase === 'lobby' || v.phase === 'snails');

  $('code-btn').textContent = v.code;
  $('round-label').textContent = roundLabel(v, d);
  renderer.setSelected(v.phase === 'betting' ? draftPick : null);
  renderBoard(v);

  // keep showing the race until its animation has played out, even if the server already moved on
  const phase = (v.phase === 'results' || v.phase === 'final') && renderer.running ? 'racing' : v.phase;
  const panel = d && phase === 'results' ? 'dheat' : d && phase === 'final' ? 'dfinal' : phase;
  showPanel(panel);
  if (phase !== 'snails') $('similar-box').hidden = true;
  if (phase === 'lobby') renderLobby(v);
  else if (phase === 'snails') renderSnails(v, d!);
  else if (phase === 'betting') renderBetting(v);
  else if (phase === 'racing') {
    $('racing-pool-line').hidden = !!d;
    if (d) renderDecisionRacing(d);
    else $('racing-pool').textContent = String(v.pools.reduce((a, b) => a + b, 0));
  } else if (phase === 'results') {
    if (d) renderHeatResults(v, d);
    else renderResults(v);
  } else if (d) renderDecisionFinal(v, d);
  else renderFinal(v);
}

function roundLabel(v: StateMsg, d: DecisionView | undefined): string {
  if (d) {
    if (v.phase === 'lobby') return 'Lobby';
    if (v.phase === 'snails') return 'Add snails';
    const final = d.heats === 1 && d.round === d.rounds;
    return final ? 'Final' : `Round ${d.round} / ${d.rounds} \u00b7 Heat ${d.heat} / ${d.heats}`;
  }
  return v.round > 0 ? `Round ${v.round} / ${v.settings.rounds}` : 'Lobby';
}

function renderBoard(v: StateMsg): void {
  const decision = isDecision(v);
  const sorted = decision ? [...v.players] : [...v.players].sort((a, b) => b.coins - a.coins);
  $('board-title').textContent = decision ? 'Players' : 'Leaderboard';
  $('board').replaceChildren(
    ...sorted.map((p, i) =>
      el(
        'li',
        { class: [p.id === v.me ? 'me' : '', p.connected ? '' : 'off'].join(' ').trim() },
        el('span', { text: `${i + 1}.` }),
        el('span', { class: 'name', text: p.name + (p.id === v.hostId ? ' ★' : '') }),
        el('span', { class: 'tick', text: v.phase === 'betting' && p.ready ? '✓' : '' }),
        el('span', { class: 'coins', text: decision ? snailCountLabel(v, p.id) : String(p.coins) }),
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

function renderDecisionRacing(d: DecisionView): void {
  const final = d.heats === 1 && d.round === d.rounds;
  $('racing-title').textContent = final ? 'The final' : `Round ${d.round} of ${d.rounds}, heat ${d.heat} of ${d.heats}`;
  const lineup = (d.lanes ?? []).map((id, lane) => el('span', { class: 'lineup' }, dot(lane), optionName(d, id)));
  $('racing-line').replaceChildren(...lineup);
}

const ORD = ['1st', '2nd', '3rd'];
const ordinal = (n: number) => ORD[n - 1] ?? `${n}th`;

function renderHeatResults(v: StateMsg, d: DecisionView): void {
  const r = d.result;
  if (!r) return;
  const lanes = d.lanes ?? [];
  $('dheat-title').textContent = `${optionName(d, r.order[0]!)} wins the heat`;
  $('dheat-note').textContent = `Round ${d.round} of ${d.rounds}, heat ${d.heat} of ${d.heats}. The top ${r.advance} of ${r.order.length} move on.`;
  const head = el('tr', {}, el('th', { text: 'Place' }), el('th', { text: 'Snail' }), el('th', { text: '' }));
  const rows = r.order.map((id, i) =>
    el(
      'tr',
      { class: i < r.advance ? 'adv' : 'out' },
      el('td', { text: ordinal(i + 1) }),
      el('td', {}, dot(lanes.indexOf(id)), optionName(d, id)),
      el('td', { class: 'num', text: i < r.advance ? 'Advances' : 'Out' }),
    ),
  );
  $('dheat-table').replaceChildren(head, ...rows);
  const host = isHost(v);
  const next = $<HTMLButtonElement>('dnext-btn');
  next.hidden = !host;
  next.textContent = d.heat < d.heats ? 'Next heat' : 'Next round';
  $('dheat-wait').textContent = host ? '' : 'Waiting for the host to continue\u2026';
}

function renderDecisionFinal(v: StateMsg, d: DecisionView): void {
  const rows = d.standings ?? [];
  const winner = rows[0];
  $('dfinal-title').textContent = winner ? `${optionName(d, winner.option)} wins!` : 'Final standings';
  const head = el('tr', {}, el('th', { text: 'Rank' }), el('th', { text: 'Snail' }), el('th', { text: 'Result' }), el('th', { text: 'Added by' }));
  const body = rows.map((s) => {
    const o = d.options.find((x) => x.id === s.option);
    const result = s.round === d.rounds ? `Final, ${ordinal(s.place)}` : `Out in round ${s.round} (${ordinal(s.place)} of ${s.size})`;
    return el(
      'tr',
      { class: s.rank === 1 ? 'adv' : '' },
      el('td', { text: ordinal(s.rank) }),
      el('td', { text: o?.name ?? '?' }),
      el('td', { text: result }),
      el('td', { text: o ? (o.by === v.me ? 'you' : o.byName) : '' }),
    );
  });
  $('dfinal-table').replaceChildren(head, ...body);
  $('drematch-btn').hidden = !isHost(v);
}
$('dnext-btn').addEventListener('click', () => send({ type: 'next' }));
$('drematch-btn').addEventListener('click', () => send({ type: 'rematch' }));

// What one coin on `lane` would return if it wins, given everyone else's bets plus this bet.
function multiplier(v: StateMsg, lane: number, amount: number): number {
  const mine = v.myBet;
  const pool = v.pools.reduce((a, b) => a + b, 0) - (mine?.amount ?? 0);
  const lanePool = (v.pools[lane] ?? 0) - (mine?.snail === lane ? mine.amount : 0);
  return (pool + amount) / (lanePool + amount);
}

const pickButtons: HTMLButtonElement[] = [];
for (let i = 0; i < SNAIL_COUNT; i++) {
  const b = el(
    'button',
    { class: 'pick', style: `border-left-color:${SNAILS[i]!.color}` },
    el('b', { text: laneLabel(i) }),
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

const amountInput = $<HTMLInputElement>('amount');
amountInput.addEventListener('input', () => view && renderBetting(view));
document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    if (!view) return;
    amountInput.value = String(Math.max(1, Math.floor(me(view).coins * Number(c.dataset.frac))));
    renderBetting(view);
  }),
);

function currentAmount(): number {
  const n = Math.floor(Number(amountInput.value));
  return Number.isFinite(n) ? n : 0;
}

function renderBetting(v: StateMsg): void {
  const self = me(v);
  const amount = currentAmount();
  const validAmount = amount >= 1 && amount <= self.coins;
  const preview = Math.max(1, validAmount ? amount : 1);

  amountInput.max = String(self.coins);
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
  if (v.myBet) {
    $('bet-status').textContent = `Locked in: ${v.myBet.amount} on ${laneLabel(v.myBet.snail)}. You can change it until betting closes.`;
  } else if (self.ready) {
    $('bet-status').textContent = 'Sitting out this round.';
  } else {
    $('bet-status').textContent = `You have ${self.coins} coins. Pick a snail and an amount.`;
  }
  updateTimer();
}

$('bet-btn').addEventListener('click', () => {
  if (draftPick !== null) send({ type: 'bet', snail: draftPick, amount: currentAmount() });
});
$('pass-btn').addEventListener('click', () => {
  draftPick = null;
  amountInput.value = '';
  send({ type: 'pass' });
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
  if (view?.phase === 'betting' && view.deadline) {
    const left = Math.max(0, Math.ceil((view.deadline - (Date.now() + clockOffset)) / 1000));
    t.textContent = `Betting closes in ${left}s`;
  } else if (view?.phase === 'betting') {
    const waiting = view.players.filter((p) => p.connected && !p.ready).length;
    t.textContent = `Waiting on ${waiting}`;
  } else {
    t.textContent = '';
  }
}
setInterval(updateTimer, 250);

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
