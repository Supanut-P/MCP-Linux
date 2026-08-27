## Summary

Describe what changed and why.

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / maintenance
- [ ] Documentation
- [ ] Security / hardening
- [ ] Release / packaging

## Verification

List the commands/tests you ran and their results.

```text
# example
corepack pnpm@10.15.0 --filter <package> test
corepack pnpm@10.15.0 --filter <package> typecheck
git diff --check
```

## Safety and compatibility

- [ ] I considered workspace/path trust boundaries and permission behavior.
- [ ] I did not add secrets, credentials, private logs, or developer-specific paths.
- [ ] Destructive behavior remains confirmation/policy gated where applicable.
- [ ] I documented migrations, compatibility changes, or rollback concerns where applicable.

## UI changes

If this changes user-visible installation or operation, include updated command output or documentation evidence.

## Checklist

- [ ] The change is focused and the diff is reviewable.
- [ ] Relevant tests were added or updated.
- [ ] Relevant lint/typecheck/tests pass.
- [ ] Tool catalog/version/README/release docs are synchronized if this change affects them.
- [ ] `git diff --check` passes.
