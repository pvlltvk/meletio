export interface Word {
  id: string;
  term: string;
  meaning: string;
  termLang?: string;
  meaningLang?: string;
  image: string | null;
  audio: string | null;
}

export interface Deck {
  id: string;
  title: string;
  termLang: string;
  meaningLang: string;
  termDir: string;
  meaningDir: string;
  words: Word[];
}

export interface Content {
  uiLanguage: string;
  decks: Deck[];
}

export interface Question {
  word: Word;
  options: Word[];
}

export interface Attempt {
  id: string;
  deckId: string;
  mode?: 'lesson';
  status: 'active' | 'completed' | 'superseded';
  revision: number;
  deck: Deck;
  questions: Question[];
  answers: {word: Word; optionId: string; correct: boolean}[];
  position: number;
  selected: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface User {
  id: string;
  email: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function invalid(message = 'Invalid request.'): never {
  throw new ApiError(400, 'invalid_request', message);
}

export function stringField(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid(`Invalid ${name}.`);
  return value;
}

export function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid('Unexpected request field.');
}

export interface DeckMetadata {
  id: string;
  title: string;
  termLang: string;
  meaningLang: string;
  termDir: string;
  meaningDir: string;
  wordCount: number;
  revision: number;
  imported: boolean;
  editable: boolean;
}

export interface TrainingAnswer {
  position: number;
  wordId: string;
  optionId: string;
  correct: boolean;
}

export interface TrainingSnapshot {
  deck: DeckMetadata;
  words: Word[];
  questions: {wordId: string; optionIds: string[]}[];
}

export interface CompactAttempt {
  id: string;
  deckId: string;
  mode?: 'lesson';
  status: Attempt['status'];
  revision: number;
  snapshotId: string;
  position: number;
  selected: string | null;
  answerCount: number;
  correct: number;
  total: number;
  lastAnswer: TrainingAnswer | null;
  createdAt: number;
  completedAt: number | null;
}
