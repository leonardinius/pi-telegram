SHELL := /bin/bash

.PHONY: test typecheck audit pack-check validate check prepush

test:
	RTK_DISABLE=1 npm test

typecheck:
	RTK_DISABLE=1 npm run typecheck

audit:
	RTK_DISABLE=1 npm run audit

pack-check:
	RTK_DISABLE=1 npm run pack:check

validate: typecheck test pack-check

check: validate

prepush: validate

audit-check:
	RTK_DISABLE=1 npm run audit
