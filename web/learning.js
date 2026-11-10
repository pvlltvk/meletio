(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Learning = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function normalizeSearch(value, language = 'und') {
    const supplied = String(language || 'und');
    let locale;
    try { locale = Intl.getCanonicalLocales(supplied)[0]; }
    catch { locale = 'und'; }
    let normalized;
    try { normalized = String(value).normalize('NFC').toLocaleLowerCase(locale); }
    catch {
      const text = String(value).normalize('NFC');
      try { normalized = text.toLocaleLowerCase('und'); }
      catch { normalized = text.toLowerCase(); }
    }
    if (locale === 'el' || locale.startsWith('el-')) {
      normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ς/g, 'σ').normalize('NFC');
    }
    return normalized;
  }

  function shuffle(items, random) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function buildQuestions(words, random = Math.random) {
    const ids = new Set();
    const terms = new Set();
    const unique = [];
    for (const word of words) {
      const id = String(word.id ?? '');
      if (!id || ids.has(id)) throw new Error('Every word must have a unique ID.');
      ids.add(id);
      if (!String(word.term ?? '').trim()) throw new Error('Every word must have a non-empty term.');
      const term = normalizeSearch(word.term, word.termLang);
      if (terms.has(term)) continue;
      terms.add(term);
      unique.push(word);
    }
    if (unique.length < 4) throw new Error('At least four unique terms are needed for multiple choice.');

    const questions = unique.flatMap(word => {
      const meaning = normalizeSearch(word.meaning, word.meaningLang || 'en');
      const usedMeanings = new Set([meaning]);
      const distractors = [];
      for (const option of shuffle(unique.filter(candidate => candidate.id !== word.id), random)) {
        const optionMeaning = normalizeSearch(option.meaning, option.meaningLang || 'en');
        if (usedMeanings.has(optionMeaning)) continue;
        usedMeanings.add(optionMeaning);
        distractors.push(option);
        if (distractors.length === 3) break;
      }
      if (distractors.length < 3) return [];
      return [{word, options: shuffle([word, ...distractors], random)}];
    });
    if (!questions.length) throw new Error('This deck needs four terms with distinct meanings for multiple choice.');
    return shuffle(questions, random);
  }

  class AudioController {
    constructor({createAudio, onError = () => {}, onStateChange = () => {}}) {
      this.createAudio = createAudio;
      this.onError = onError;
      this.onStateChange = onStateChange;
      this.current = null;
      this.prepared = null;
      this.state = null;
      this.automaticErrorReported = false;
    }

    changeState(state, current) {
      const next = {state, source: current?.source || null, wordId: current?.wordId};
      if (this.state?.state === state && this.state.source === next.source && this.state.wordId === next.wordId) return;
      this.state = next;
      this.onStateChange(next);
    }

    releasePrepared() {
      const prepared = this.prepared;
      this.prepared = null;
      if (!prepared) return;
      for (const [name, listener] of prepared.listeners) {
        if (prepared.audio.removeEventListener) prepared.audio.removeEventListener(name, listener);
        else if (prepared.audio['on' + name] === listener) prepared.audio['on' + name] = null;
      }
      prepared.audio.pause();
      if (prepared.audio.removeAttribute) {
        prepared.audio.removeAttribute('src');
        prepared.audio.load?.();
      }
    }

    prepare(source) {
      if (!source) { this.stop(); return false; }
      if (this.prepared?.source === source) return true;
      this.stop();
      const audio = this.createAudio(source);
      const prepared = {audio, source, listeners: []};
      this.prepared = prepared;
      audio.preload = 'auto';
      const listen = (name, callback) => {
        const listener = () => {
          const current = this.current;
          if (this.prepared !== prepared || !current || current.audio !== audio) return;
          callback(current);
        };
        prepared.listeners.push([name, listener]);
        if (audio.addEventListener) audio.addEventListener(name, listener);
        else audio['on' + name] = listener;
      };
      listen('playing', current => this.changeState('playing', current));
      listen('waiting', current => this.changeState('loading', current));
      listen('ended', current => {
        if (audio.ended === false) return;
        this.current = null;
        this.changeState('idle', current);
      });
      listen('error', current => this.fail(current, audio.error || new Error('Audio could not play.')));
      audio.load?.();
      return true;
    }

    fail(current, error) {
      if (this.current !== current) return false;
      this.current = null;
      this.releasePrepared();
      if (error?.name === 'AbortError') {
        this.changeState('idle', current);
        return false;
      }
      this.changeState('error', current);
      if (!current.automatic || !this.automaticErrorReported) {
        if (current.automatic) this.automaticErrorReported = true;
        this.onError(error, {automatic: current.automatic});
      }
      return false;
    }

    async play(source, {automatic = false, wordId} = {}) {
      if (!source) return false;
      let current;
      try {
        if (this.current) {
          const previous = this.current;
          this.current = null;
          previous.audio.pause();
        }
        this.prepare(source);
        const audio = this.prepared.audio;
        current = {audio, source, automatic, wordId};
        this.current = current;
        try { audio.currentTime = 0; } catch {}
        this.changeState('loading', current);
        await audio.play();
        if (this.current !== current) return false;
        this.changeState('playing', current);
        return true;
      } catch (error) {
        if (!current) {
          current = {source, automatic, wordId};
          this.current = current;
        }
        return this.fail(current, error);
      }
    }

    stop() {
      const current = this.current;
      this.current = null;
      this.releasePrepared();
      if (current || this.state) this.changeState('idle', current || this.state);
    }
  }

  return {AudioController, buildQuestions, normalizeSearch};
});
