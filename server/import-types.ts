export interface ParsedPackage {
  decks: {id: string; name: string; filtered?: boolean}[];
  noteTypes: {id: string; name: string; fields: string[]; type: number}[];
  notes: {guid: string; id: string; noteTypeId: string; deckIds: string[]; modified: number; fields: string[]; mediaFields?: {images: number[]; audio: number[]}}[];
  media: {entryId: string; name: string; path: string | null; mime: string | null; size: number; sha256: string | null; error?: string; optimized?: boolean; originalSize?: number}[];
  suggestion?: {sourceDeckId: string; noteTypeId: string; includeChildren: boolean; title: string; mapping: {term: string | null; meaning: string | null; image: string | null; audio: string | null}} | null;
  sourceChoices?: {sourceDeckId: string; noteTypeId: string; noteCount: number; title: string; noteTypeName: string; suggestion: ParsedPackage['suggestion']}[];
  sourceIdentities?: {sourceDeckId: string; noteTypeId: string}[];
}

export const IMPORT_LIMITS = {
  archiveBytes: 100 * 1024 * 1024,
  unpackedBytes: 128 * 1024 * 1024,
  databaseBytes: 32 * 1024 * 1024,
  mediaBytes: 512 * 1024,
  imageSourceBytes: 8 * 1024 * 1024,
  imagePixels: 16000000,
  imageDimension: 1024,
  mediaMapBytes: 2 * 1024 * 1024,
  entries: 5000,
  notes: 10000,
  cards: 10000,
  selectedNotes: 2000,
  fieldBytes: 64 * 1024,
  metadataBytes: 1024 * 1024,
  parserOutputBytes: 16 * 1024 * 1024
} as const;
