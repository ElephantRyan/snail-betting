// Wire types shared with the Go server (see game.go: stateMsg, raceMsg, Results).

export const SNAIL_COUNT = 6;

export type Phase = 'lobby' | 'snails' | 'betting' | 'racing' | 'results' | 'final';
export type Mode = 'classic' | 'decision';

// Decision mode bracket limits (see decision.go)
export const MAX_OPTIONS = 64;
export const MAX_HEAT = 8;
export const MAX_OPTION_LEN = 24;

export interface Settings {
  rounds: number;
  startCoins: number;
  betSeconds: number;
  mode: Mode;
}

export interface Bet {
  snail: number;
  amount: number;
}

export interface PlayerView {
  id: string;
  name: string;
  coins: number;
  connected: boolean;
  ready: boolean;
  bailout: boolean;
}

export interface ResultRow {
  id: string;
  name: string;
  snail: number;
  amount: number;
  payout: number;
  place: number; // 1-3 if the snail finished on the podium, else 0
}

export interface Results {
  winner: number;
  order: number[];
  pool: number;
  refunded: boolean;
  rows: ResultRow[];
  round: number;
}

export interface StateMsg {
  type: 'state';
  serverNow: number;
  code: string;
  phase: Phase;
  round: number;
  settings: Settings;
  deadline: number | null;
  hostId: string;
  me: string;
  players: PlayerView[];
  pools: number[];
  backers: number[];
  myBet: Bet | null;
  results: Results | null;
  decision?: DecisionView;
}

export interface OptionView {
  id: number;
  name: string;
  by: string; // player id
  byName: string;
}

export interface HeatResult {
  order: number[]; // option ids, first to last
  advance: number;
  final: boolean;
}

export interface StandRow {
  option: number;
  rank: number;
  round: number; // bracket round they last raced in (== rounds for finalists)
  place: number; // finishing place in that heat
  size: number; // snails in that heat
}

export interface DecisionView {
  options: OptionView[];
  round: number;
  rounds: number;
  heat: number;
  heats: number;
  lanes: number[] | null; // option ids in lane order for the current heat
  result: HeatResult | null;
  standings: StandRow[] | null;
}

export interface RaceMsg {
  type: 'race';
  serverNow: number;
  startAt: number;
  fps: number;
  frames: number[][]; // [frame][lane], 1000 = finish line, runs past it until every snail is off screen
  order: number[]; // lanes, first to cross the line first
  labels?: string[]; // decision mode: the name on each lane
}

export interface JoinedMsg {
  type: 'joined';
  code: string;
  token: string;
  id: string;
  name: string;
}

export interface HelloMsg {
  type: 'hello';
  boot: string; // changes whenever the server restarts
}

export interface SimilarMsg {
  type: 'similar';
  name: string; // what was typed
  match: string; // the existing snail it resembles
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type ServerMsg = StateMsg | RaceMsg | JoinedMsg | HelloMsg | SimilarMsg | ErrorMsg;

export type ClientMsg =
  | { type: 'create'; name: string; settings: Settings }
  | { type: 'join'; code: string; name: string; token?: string }
  | { type: 'start' | 'pass' | 'close' | 'next' | 'rematch' | 'begin' }
  | { type: 'addSnail'; name: string; force?: boolean }
  | { type: 'removeSnail'; id: number }
  | { type: 'bet'; snail: number; amount: number };

export const SNAILS = [
  { name: 'Red', color: '#e5484d' },
  { name: 'Blue', color: '#3e8bff' },
  { name: 'Green', color: '#3ecf5c' },
  { name: 'Yellow', color: '#ffc933' },
  { name: 'Purple', color: '#a35cff' },
  { name: 'Orange', color: '#ff8a2b' },
  { name: 'Teal', color: '#19c3b1' },
  { name: 'Pink', color: '#ff6fb5' },
] as const;
