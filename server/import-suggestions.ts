import {extractField} from './import-html';
import type {ParsedPackage} from './import-types';

export function profileMediaFields(fields: string[]) {
  const mediaFields = {images: [] as number[], audio: [] as number[]};
  for (let index = 0; index < fields.length; index++) {
    if (!/[<&]|\[sound:/i.test(fields[index])) continue;
    const field = extractField(fields[index]);
    if (field.images.length) mediaFields.images.push(index);
    if (field.audio.length) mediaFields.audio.push(index);
  }
  return mediaFields;
}

export function suggestImport(parsed: ParsedPackage, source?: {sourceDeckId: string; noteTypeId: string}) {
  const decks = new Map(parsed.decks.map(deck => [deck.id, deck]));
  const models = new Map(parsed.noteTypes.filter(model => model.type === 0).map(model => [model.id, model]));
  const choices = new Map<string, {deck: ParsedPackage['decks'][number]; model: ParsedPackage['noteTypes'][number]; count: number}>();
  for (const note of parsed.notes) {
    const model = models.get(note.noteTypeId);
    if (!model) continue;
    for (const id of new Set(note.deckIds)) {
      const deck = decks.get(id);
      if (!deck || deck.filtered) continue;
      const key = id + ':' + model.id;
      const value = choices.get(key) || {deck, model, count: 0};
      value.count++;
      choices.set(key, value);
    }
  }
  const selected = source ? {deck: decks.get(source.sourceDeckId), model: models.get(source.noteTypeId)}
    : [...choices.values()].sort((a, b) => b.count - a.count || a.deck.name.length - b.deck.name.length)[0];
  if (!selected?.deck || !selected.model) return null;
  const {deck, model} = selected;
  const wanted = new Set(parsed.decks.filter(item => item.id === deck.id || item.name.startsWith(deck.name + '::')).map(item => item.id));
  const notes = parsed.notes.filter(note => note.noteTypeId === model.id && note.deckIds.some(id => wanted.has(id)));
  const field = (pattern: RegExp, fallback: string | null) => model.fields.find(name => pattern.test(name)) || fallback;
  const mediaField = (kind: 'images' | 'audio') => {
    const counts = model.fields.map(() => 0);
    for (const note of notes) for (const index of note.mediaFields?.[kind] || []) counts[index]++;
    const maximum = Math.max(...counts);
    return maximum > 0 ? model.fields[counts.indexOf(maximum)] : null;
  };
  return {sourceDeckId: deck.id, noteTypeId: model.id, includeChildren: true, title: deck.name.slice(0, 120),
    mapping: {term: field(/^(term|front|word|greek)$/i, model.fields[0] || null),
      meaning: field(/^(meaning|back|translation|english)$/i, model.fields[1] || model.fields[0] || null),
      image: mediaField('images'), audio: mediaField('audio')}};
}

export function importSourceChoices(parsed: ParsedPackage) {
  const decks = new Map(parsed.decks.filter(deck => !deck.filtered).map(deck => [deck.id, deck]));
  const models = new Map(parsed.noteTypes.filter(model => model.type === 0).map(model => [model.id, model]));
  const ancestors = new Map([...decks.values()].map(deck => [deck.id, [...decks.values()].filter(parent => parent.id === deck.id || deck.name.startsWith(parent.name + '::'))]));
  const counts = new Map<string, {sourceDeckId: string; noteTypeId: string; noteCount: number; title: string; noteTypeName: string}>();
  for (const note of parsed.notes) {
    const model = models.get(note.noteTypeId);
    if (!model) continue;
    const seen = new Set<string>();
    for (const id of note.deckIds) for (const deck of ancestors.get(id) || []) {
      const key = JSON.stringify([deck.id, model.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const choice = counts.get(key) || {sourceDeckId: deck.id, noteTypeId: model.id, noteCount: 0, title: deck.name, noteTypeName: model.name};
      choice.noteCount++;
      counts.set(key, choice);
    }
  }
  const choices = [...counts.values()];
  return {
    sourceIdentities: choices.map(({sourceDeckId, noteTypeId}) => ({sourceDeckId, noteTypeId})),
    sourceChoices: choices.filter(choice => !choices.some(parent => parent.noteTypeId === choice.noteTypeId && choice.title.startsWith(parent.title + '::')))
      .map(choice => ({...choice, suggestion: suggestImport(parsed, choice)}))
  };
}
