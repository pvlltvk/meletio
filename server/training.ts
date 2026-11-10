import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {transaction} from './database';
import {ContentRepository, deckMetadata} from './content';
import {Reviews} from './reviews';
import {ApiError, fields, invalid, stringField, type Attempt, type CompactAttempt, type Content, type Deck, type Question, type TrainingAnswer, type TrainingSnapshot, type Word} from './types';

const {buildQuestions} = require(resolve(__dirname, '../../web/learning.js')) as {buildQuestions: (words: Word[]) => Question[]};
const snapshotLimit = 2 * 1024 * 1024;
const legacyLimit = 2 * 1024 * 1024;

interface StoredAttempt {state: string}
interface StoredCompact extends CompactAttempt {storageVersion: 2}
type State = Attempt | StoredCompact;
interface Receipt {storageVersion: 2; attempt: CompactAttempt}

function normalized(state: State): state is StoredCompact {
  return 'storageVersion' in state && state.storageVersion === 2;
}

function project(state: State): CompactAttempt {
  if (normalized(state)) {
    const {storageVersion, ...attempt} = state;
    return attempt;
  }
  const last = state.answers[state.answers.length - 1];
  return {id: state.id, deckId: state.deckId, status: state.status, revision: state.revision,
    ...(state.mode === 'lesson' ? {mode: state.mode} : {}),
    snapshotId: state.id, position: state.position, selected: state.selected,
    answerCount: state.answers.length, correct: state.answers.filter(answer => answer.correct).length,
    total: state.questions.length, lastAnswer: last ? {position: state.answers.length - 1, wordId: last.word.id, optionId: last.optionId, correct: last.correct} : null,
    createdAt: state.createdAt, completedAt: state.completedAt};
}

function snapshotFrom(deck: Deck, questions: Question[]): TrainingSnapshot {
  return {deck: deckMetadata(deck),
    words: deck.words.map(word => ({...word, termLang: word.termLang || deck.termLang, meaningLang: word.meaningLang || deck.meaningLang})),
    questions: questions.map(question => ({wordId: question.word.id, optionIds: question.options.map(option => option.id)}))};
}

function checkBudget(value: unknown, limit: number, code: string, message: string) {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new ApiError(422, code, message);
}

export class Training {
  private content: ContentRepository;
  private reviews: Reviews;

  constructor(private db: DatabaseSync, content: ContentRepository | Content, private now: () => number) {
    this.content = content instanceof ContentRepository ? content : new ContentRepository(db, content);
    this.reviews = new Reviews(db);
  }

  private stored(userId: string, id: string): State {
    const row = this.db.prepare('SELECT state FROM training_attempts WHERE id = ? AND user_id = ?').get(id, userId) as StoredAttempt | undefined;
    if (!row) throw new ApiError(404, 'not_found', 'Practice session not found.');
    return JSON.parse(row.state) as State;
  }

  snapshot(userId: string, id: string): TrainingSnapshot {
    const state = this.stored(userId, id);
    const row = this.db.prepare('SELECT content FROM training_snapshots WHERE id = ? AND owner_id = ?').get(id, userId) as {content: string} | undefined;
    const snapshot = row ? JSON.parse(row.content) as TrainingSnapshot : !normalized(state) ? snapshotFrom(state.deck, state.questions) : undefined;
    if (!snapshot) throw new ApiError(404, 'not_found', 'Practice snapshot not found.');
    checkBudget(snapshot, snapshotLimit, 'snapshot_too_large', 'This practice snapshot exceeds the supported limit.');
    return snapshot;
  }

  private answerRows(userId: string, state: CompactAttempt, offset = 0, limit = state.answerCount): TrainingAnswer[] {
    const stored = this.stored(userId, state.id);
    if (!normalized(stored)) {
      return stored.answers.slice(offset, Math.min(state.answerCount, offset + limit)).map((answer, index) => ({position: offset + index, wordId: answer.word.id, optionId: answer.optionId, correct: answer.correct}));
    }
    return (this.db.prepare('SELECT position, word_id, option_id, correct FROM training_answers WHERE attempt_id = ? AND position >= ? AND position < ? ORDER BY position LIMIT ?')
      .all(state.id, offset, state.answerCount, limit) as unknown as {position: number; word_id: string; option_id: string; correct: number}[])
      .map(row => ({position: row.position, wordId: row.word_id, optionId: row.option_id, correct: Boolean(row.correct)}));
  }

  history(userId: string, id: string, cursor?: string) {
    const state = project(this.stored(userId, id));
    if (cursor !== undefined && (!/^(0|[1-9][0-9]{0,9})$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) invalid('Invalid answer cursor.');
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (offset > state.answerCount) invalid('Invalid answer cursor.');
    const answers = this.answerRows(userId, state, offset, 100);
    const next = offset + answers.length;
    return {answers, nextCursor: next < state.answerCount ? String(next) : null};
  }

  private expand(userId: string, state: CompactAttempt): Attempt {
    const stored = this.stored(userId, state.id);
    if (!normalized(stored)) {
      return {...stored, status: state.status, revision: state.revision, position: state.position, selected: state.selected,
        answers: stored.answers.slice(0, state.answerCount), createdAt: state.createdAt, completedAt: state.completedAt};
    }
    const snapshot = this.snapshot(userId, state.id);
    const words = new Map(snapshot.words.map(word => [word.id, word]));
    const word = (id: string): Word => {
      const value = words.get(id);
      if (!value) throw new Error('Practice snapshot has an unknown word.');
      return value;
    };
    return {id: state.id, deckId: state.deckId, status: state.status, revision: state.revision,
      ...(state.mode === 'lesson' ? {mode: state.mode} : {}),
      deck: {...snapshot.deck, words: snapshot.words},
      questions: snapshot.questions.map(question => ({word: word(question.wordId), options: question.optionIds.map(word)})),
      answers: this.answerRows(userId, state).map(answer => ({word: word(answer.wordId), optionId: answer.optionId, correct: answer.correct})),
      position: state.position, selected: state.selected, createdAt: state.createdAt, completedAt: state.completedAt};
  }

  private render(userId: string, state: State | CompactAttempt, compact: boolean): Attempt | CompactAttempt {
    const projection = 'answers' in state ? project(state) : 'storageVersion' in state ? project(state as StoredCompact) : state;
    if (compact) return projection;
    const attempt = 'answers' in state ? state : this.expand(userId, projection);
    checkBudget({attempt}, legacyLimit, 'compact_required', 'This practice is too large for the legacy format. Request format=compact.');
    return attempt;
  }

  owned(userId: string, id: string): Attempt;
  owned(userId: string, id: string, compact: true): CompactAttempt;
  owned(userId: string, id: string, compact: boolean): Attempt | CompactAttempt;
  owned(userId: string, id: string, compact = false): Attempt | CompactAttempt {
    return this.render(userId, this.stored(userId, id), compact);
  }

  private summary(state: State) {
    const attempt = project(state);
    return {id: attempt.id, deckId: attempt.deckId, correct: attempt.correct, total: attempt.answerCount, completedAt: attempt.completedAt,
      ...(attempt.mode === 'lesson' ? {mode: attempt.mode} : {})};
  }

  results(userId: string, deckId: string) {
    this.content.metadata(userId, deckId);
    return (this.db.prepare("SELECT state FROM training_attempts WHERE user_id = ? AND deck_id = ? AND status = 'completed' ORDER BY completed_at DESC, rowid DESC LIMIT 50").all(userId, deckId) as unknown as StoredAttempt[])
      .map(row => this.summary(JSON.parse(row.state) as State));
  }

  current(userId: string, deckId: string, compact = false) {
    const deck = this.content.deck(userId, deckId);
    let questions: Question[] = [];
    try { questions = buildQuestions(this.words(deck)); }
    catch {}
    const eligible = new Set(questions.map(question => question.word.id));
    const review = this.reviews.summary(userId, deck, deck.words.filter(word => eligible.has(word.id)), this.now());
    const row = this.db.prepare("SELECT state FROM training_attempts WHERE user_id = ? AND deck_id = ? AND status = 'active'").get(userId, deckId) as StoredAttempt | undefined;
    const result = {attempt: row ? this.render(userId, JSON.parse(row.state) as State, compact) : null, latestResult: this.results(userId, deckId)[0] || null, review};
    if (!compact) checkBudget(result, legacyLimit, 'compact_required', 'This practice is too large for the legacy format. Request format=compact.');
    return result;
  }

  private persist(userId: string, state: State) {
    this.db.prepare('UPDATE training_attempts SET state = ?, status = ?, completed_at = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(state), state.status, state.completedAt, state.id, userId);
  }

  private words(deck: Deck) {
    return deck.words.map(word => ({...word, termLang: word.termLang || deck.termLang, meaningLang: word.meaningLang || deck.meaningLang}));
  }

  private create(userId: string, deck: Deck, missed?: Set<string>, lesson = false): StoredCompact {
    const words = this.words(deck);
    let questions: Question[];
    try { questions = buildQuestions(words); }
    catch { invalid('This deck needs four distinct terms with different meanings.'); }
    if (lesson) {
      const eligible = new Set(questions.map(question => question.word.id));
      const selected = this.reviews.select(userId, deck, words.filter(word => eligible.has(word.id)), this.now());
      questions = questions.filter(question => selected.has(question.word.id));
      if (!questions.length) throw new ApiError(409, 'lesson_unavailable', 'No words are due for a lesson. Reload Study to check your review dates.');
    }
    if (missed) questions = questions.filter(question => missed.has(question.word.id));
    if (!questions.length) invalid('There are no missed words to practice.');
    const snapshot = snapshotFrom(deck, questions);
    checkBudget(snapshot, snapshotLimit, 'snapshot_too_large', 'This learning set exceeds the practice snapshot limit.');
    const rows = this.db.prepare("SELECT state FROM training_attempts WHERE user_id = ? AND deck_id = ? AND status = 'active'").all(userId, deck.id) as unknown as StoredAttempt[];
    for (const row of rows) {
      const old = JSON.parse(row.state) as State;
      old.status = 'superseded';
      this.persist(userId, old);
    }
    const id = randomUUID();
    const state: StoredCompact = {storageVersion: 2, id, deckId: deck.id, status: 'active', revision: 0, snapshotId: id,
      ...(lesson ? {mode: 'lesson' as const} : {}),
      position: 0, selected: null, answerCount: 0, correct: 0, total: questions.length, lastAnswer: null, createdAt: this.now(), completedAt: null};
    this.db.prepare('INSERT INTO training_attempts VALUES (?, ?, ?, ?, ?, ?, NULL)').run(id, userId, deck.id, state.status, JSON.stringify(state), state.createdAt);
    this.db.prepare('INSERT INTO training_snapshots (id, owner_id, content) VALUES (?, ?, ?)').run(id, userId, JSON.stringify(snapshot));
    return state;
  }

  private question(userId: string, state: State): {wordId: string; optionIds: string[]} {
    if (!normalized(state)) {
      const question = state.questions[state.position];
      return {wordId: question.word.id, optionIds: question.options.map(word => word.id)};
    }
    const row = this.db.prepare('SELECT json_extract(content, ?) AS question FROM training_snapshots WHERE id = ? AND owner_id = ?')
      .get(`$.questions[${state.position}]`, state.snapshotId, userId) as {question: string | null} | undefined;
    if (!row?.question) throw new Error('Practice question not found.');
    return JSON.parse(row.question) as {wordId: string; optionIds: string[]};
  }

  private reviewAnswer(userId: string, state: State, wordId: string, correct: boolean) {
    if (state.mode !== 'lesson') return;
    let current: Deck;
    try { current = this.content.deck(userId, state.deckId); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    const word = current.words.find(word => word.id === wordId);
    if (!word) return;
    const snapshot = this.snapshot(userId, state.id);
    const saved = snapshot.words.find(word => word.id === wordId);
    if (!saved) throw new Error('Practice snapshot has an unknown word.');
    this.reviews.answer(userId, current, word, snapshot.deck, saved, correct, this.now());
  }

  mutate(userId: string, action: string, id: string | undefined, body: Record<string, unknown>, compact = false) {
    if (id) this.stored(userId, id);
    if (!['start', 'answer', 'advance', 'retry'].includes(action)) invalid('Invalid practice action.');
    const allowed = action === 'start' ? ['deckId', 'mode', 'requestId'] : action === 'answer' ? ['position', 'optionId', 'revision', 'requestId'] : action === 'advance' ? ['position', 'revision', 'requestId'] : ['requestId'];
    fields(body, allowed);
    if (action === 'start' && body.mode !== undefined && body.mode !== 'lesson' && body.mode !== 'practice') invalid('Invalid practice mode.');
    if (action === 'answer' || action === 'advance') {
      if (!Number.isSafeInteger(body.position) || (body.position as number) < 0 || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) invalid('Invalid practice position or revision.');
    }
    const requestId = stringField(body.requestId, 'request ID', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify([action, id, Object.entries(body).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    return transaction(this.db, () => {
      const receipt = this.db.prepare('SELECT fingerprint, response FROM mutation_receipts WHERE user_id = ? AND request_id = ?').get(userId, requestId) as {fingerprint: string; response: string} | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'request_conflict', 'Request ID was already used for another action.');
        const saved = JSON.parse(receipt.response) as Receipt | {attempt: Attempt};
        const response = {attempt: this.render(userId, saved.attempt, compact)};
        checkBudget(response, compact ? 4096 : legacyLimit, compact ? 'mutation_too_large' : 'compact_required', 'Use compact format for this practice.');
        return response;
      }
      let state: State;
      if (action === 'start') {
        state = this.create(userId, this.content.deck(userId, stringField(body.deckId, 'learning set')), undefined, body.mode === 'lesson');
      } else {
        state = this.stored(userId, id!);
        if (action === 'retry') {
          if (state.status !== 'completed') throw new ApiError(409, 'not_completed', 'Finish this session before retrying missed words.');
          const snapshot = this.snapshot(userId, state.id);
          const current = this.content.deck(userId, state.deckId);
          const retained = new Set(current.words.map(word => word.id));
          const missed = new Set(this.answerRows(userId, project(state)).filter(answer => !answer.correct).map(answer => answer.wordId));
          state = this.create(userId, {...snapshot.deck, words: snapshot.words.filter(word => retained.has(word.id))}, missed);
        } else {
          if (state.status !== 'active' || body.revision !== state.revision || body.position !== state.position) throw new ApiError(409, 'stale_session', 'Practice changed. Reload to resume the saved session.');
          if (action === 'answer') {
            const optionId = stringField(body.optionId, 'answer');
            if (state.selected !== null) throw new ApiError(409, 'already_answered', 'The first answer is already saved.');
            const question = this.question(userId, state);
            if (!question.optionIds.includes(optionId)) invalid('Choose one of the offered answers.');
            const correct = optionId === question.wordId;
            this.reviewAnswer(userId, state, question.wordId, correct);
            state.selected = optionId;
            if (normalized(state)) {
              this.db.prepare('INSERT INTO training_answers (attempt_id, position, word_id, option_id, correct) VALUES (?, ?, ?, ?, ?)').run(state.id, state.position, question.wordId, optionId, Number(correct));
              state.answerCount++;
              state.correct += Number(correct);
              state.lastAnswer = {position: state.position, wordId: question.wordId, optionId, correct};
            } else state.answers.push({word: state.questions[state.position].word, optionId, correct});
          } else {
            if (state.selected === null) throw new ApiError(409, 'not_answered', 'Answer before continuing.');
            state.position++;
            state.selected = null;
            if (state.position === project(state).total) {
              state.status = 'completed';
              state.completedAt = this.now();
            }
          }
          state.revision++;
          this.persist(userId, state);
        }
      }
      const projection = project(state);
      const response = {attempt: this.render(userId, state, compact)};
      checkBudget(response, compact ? 4096 : legacyLimit, compact ? 'mutation_too_large' : 'compact_required', 'Use compact format for this practice.');
      const saved: Receipt = {storageVersion: 2, attempt: projection};
      this.db.prepare('INSERT INTO mutation_receipts VALUES (?, ?, ?, ?, ?)').run(userId, requestId, fingerprint, JSON.stringify(saved), this.now());
      return response;
    });
  }
}
