NPM ?= npm
PORT ?= 4173
export BACKUP_PATH

.PHONY: build serve test check backup

build:
	$(NPM) run build

serve: build
	PORT=$(PORT) $(NPM) start

test:
	$(NPM) test

check:
	$(NPM) run check

backup:
	@test -n "$$BACKUP_PATH" || { echo 'Set BACKUP_PATH to an absolute path outside the project.' >&2; exit 1; }
	$(NPM) run compile
	node dist/scripts/backup.js "$$BACKUP_PATH"
