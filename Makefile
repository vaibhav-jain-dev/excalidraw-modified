PORT ?= 3056
PID_FILE := /tmp/excalidraw-dev.pid
LOG_FILE := /tmp/excalidraw-dev.log

.PHONY: run stop restart logs status

## Start the dev server in the background (no browser auto-open)
run:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Already running (pid $$(cat $(PID_FILE))). Use 'make restart' to restart."; \
	else \
		nohup yarn start --no-open > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
		echo "Starting dev server (pid $$(cat $(PID_FILE))), logs: $(LOG_FILE)"; \
		sleep 1; \
		tail -n 5 $(LOG_FILE) 2>/dev/null || true; \
	fi

## Stop the dev server
stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		pkill -P $$(cat $(PID_FILE)) 2>/dev/null || true; \
		kill $$(cat $(PID_FILE)) 2>/dev/null || true; \
		rm -f $(PID_FILE); \
		echo "Stopped."; \
	else \
		echo "Not running (no valid pid file)."; \
		rm -f $(PID_FILE); \
	fi

## Restart the dev server
restart: stop run

## Tail the dev server logs
logs:
	@tail -f $(LOG_FILE)

## Show whether the dev server is running
status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Running (pid $$(cat $(PID_FILE))) at http://localhost:$(PORT)/"; \
	else \
		echo "Not running."; \
	fi

# Re-seed the design canvas from its sources (see design/README.md).
# SKILL points at the bundled /design skill that ships the payload template.
SKILL ?= $(wildcard /tmp/claude-*/bundled-skills/*/*/design)
DESIGN_DIR := design/dashboard-redesign
DESIGN_OUT := $(DESIGN_DIR)/excalidraw-library-redesign.html

.PHONY: design
design:
	@test -n "$(SKILL)" || { echo "design skill not found; run /design once to extract it"; exit 1; }
	node "$(SKILL)/seed-canvas.mjs" \
	  --template "$(SKILL)/payload.template.html" \
	  --out $(DESIGN_OUT) --title "Excalidraw Library Redesign" \
	  $(foreach f,$(wildcard $(DESIGN_DIR)/*.dc.html),--artboard $(f) ) \
	  --canvas $(DESIGN_DIR)/canvas.json
	node "$(SKILL)/seed-canvas.mjs" --check $(DESIGN_OUT)
