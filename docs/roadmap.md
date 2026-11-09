# Roadmap and decisions

## Current

Language-agnostic local application: study, gallery, search/details, multiple
choice, results/missed-word retry, durable per-account/per-deck resume and optional
automatic pronunciation. TypeScript backend, SQLite and email/password accounts
are implemented. Private one-way Anki deck import supports compatible exports,
field mapping, images/audio, preview and stable-ID updates. Python has been removed
from build, serving and tests.

Import now starts from file selection with a concise preview and Advanced options.
All signed-in sets support word editing/deletion and set renaming/deletion.
Default-set changes stay private to each account; imported local changes survive
reimport by default. Study has a simpler banner and Listen keeps a steady label
with delayed loading feedback. WAL-safe backup/restore and repeatable external
browser checks are implemented; final iPhone acceptance is pending.

The vanilla frontend and minimal Quizlet-inspired visual direction remain. No
timers, streak pressure or rewards. Demo content uses original SVG pictures and
no recordings. Human pronunciation remains optional; no speech is synthesized.

## Next product milestones

1. Check Anki import/file picking and audio on real iPhones/Safari, plus VoiceOver.
2. Add deliberate account recovery and lifecycle policies before hosted use.
3. Define lessons and snapshot/receipt/media retention; basic content editing is implemented.
4. Define offline downloads, synchronization and conflict semantics.
5. Consider HTTPS/VPS deployment after production security and operational review.
6. Evaluate iOS/Android packaging after the PWA meets real needs.

Current progress is independent application progress. Compatible .apkg import is
implemented; modern compressed exports, AnkiConnect, scheduling and two-way
synchronization remain separate decisions. Direct AnkiWeb account access is outside
the current scope.

There is no service worker, installable PWA, native build, offline save queue or
Anki synchronization. React/Capacitor migrations remain future possibilities. Media
licensing, final branding and production security need review before publication
or deployment. No publication or deployment is part of this increment.
