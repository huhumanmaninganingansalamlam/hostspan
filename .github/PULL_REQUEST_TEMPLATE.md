## Problem and user impact

What specific failure, maintenance cost or requirement does this change address? What was the prior observable behavior?

## Change and ownership

Which module or lifecycle boundary owns the change, and why? Describe only the meaningful behavior/contract differences; link detailed implementation docs rather than copying them.

## Verification actually performed

Record commands, observed results and target OS/architecture. Include failures fixed, platform skips and any native installer, GUI, credential or signing checks **not run**. Do not claim that an unchecked CI job passed.

## Compatibility, authority and recovery

Does this affect public MCP tool names/schema/descriptions, version/hash, CLI outputs/exit codes, OAuth/private-token scopes, file/exec/PTY authority, idempotency, recovery, OS consent or sensitive logging? State unchanged boundaries explicitly when relevant. Document how failures remain fail-closed.

## Related issue/Task, rollout and rollback

Link a public issue or internal repoctl Task when applicable. State deployment/restart requirements, safe rollback and any outstanding externally owned gate.
