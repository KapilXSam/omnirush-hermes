SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install uninstall start test test-unit test-integration test-live lint scan check status logs restart reauth service publish package release

help: ## Show this help
	@printf '\n\033[1momnirush-hermes\033[0m — local OpenAI-compatible bridge for OmniRush models\n\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

install: ## Full setup: credentials, service, Hermes wiring, verification
	./install.sh

uninstall: ## Remove the service, provider and aliases
	./uninstall.sh

start: ## Run the proxy in the foreground
	node src/proxy.mjs

test: test-unit test-integration ## All offline tests (no network, no credentials)

test-unit: ## Translation-layer assertions
	node tests/smoke.mjs

test-integration: ## Boot the proxy and assert its HTTP surface
	node tests/server.mjs

test-live: ## Live assertions against a running proxy (needs credentials)
	bash scripts/test-proxy.sh

lint: ## Syntax checks (JS + shell)
	npm run --silent lint

scan: ## Secret gate over the tree and full git history
	npm run --silent scan

check: lint test scan ## Everything CI runs, locally

service: ## Service control: make service ARGS="status"
	bash scripts/ctl.sh $(ARGS)

status: ## Service state + live health
	bash scripts/ctl.sh status

logs: ## Tail the service log
	bash scripts/ctl.sh logs

restart: ## Restart the background service
	bash scripts/ctl.sh restart

reauth: ## Re-run the OmniRush login, refresh the store, restart
	bash scripts/ctl.sh reauth

package: ## Show what would be published to npm
	npm pack --dry-run

publish: ## Push to GitHub (gated: scan, commit, create, verify)
	bash scripts/publish.sh omnirush-hermes

release: ## Tag and release: make release VERSION=1.2.0
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	sed -i '' 's/"version": "[^"]*"/"version": "$(VERSION)"/' package.json 2>/dev/null || \
	  sed -i 's/"version": "[^"]*"/"version": "$(VERSION)"/' package.json
	git commit -am "release: v$(VERSION)"
	git tag -a "v$(VERSION)" -m "v$(VERSION)"
	git push --follow-tags
	gh release create "v$(VERSION)" --generate-notes
