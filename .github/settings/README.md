# Repository settings as code

Settings that can't be expressed in workflow files. Apply them with `gh`.

## Branch ruleset

[`main-ruleset.json`](main-ruleset.json) protects `main`: no deletion or force-push, linear
history, changes only through squash-merged pull requests, and the `CI` check must pass.
Admins can bypass it only through a pull request (`bypass_mode: pull_request`) — nobody,
including an agent using the owner's token, can push to `main` directly. Applied (the
repository is public, so rulesets are free). Create it, or update it after editing:

```sh
gh api -X POST repos/tkarakai/toolbelt-ps/rulesets --input .github/settings/main-ruleset.json
ID=$(gh api repos/tkarakai/toolbelt-ps/rulesets --jq '.[] | select(.name=="main") | .id')
gh api -X PUT repos/tkarakai/toolbelt-ps/rulesets/$ID --input .github/settings/main-ruleset.json
```

## Applied settings

```sh
R=repos/tkarakai/toolbelt-ps
gh api -X PATCH $R -F has_wiki=false -F has_projects=false -F has_discussions=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_update_branch=true
gh api -X PUT $R/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT $R/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT $R/actions/permissions/selected-actions --input - <<'JSON'
{"github_owned_allowed": true, "verified_allowed": false,
 "patterns_allowed": ["oven-sh/setup-bun@*", "zizmorcore/zizmor-action@*"]}
JSON
gh api -X PUT $R/vulnerability-alerts
gh api -X PUT $R/automated-security-fixes
gh api -X PUT $R/private-vulnerability-reporting
gh api -X PUT $R/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
gh api -X PATCH $R --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"},
 "secret_scanning_push_protection": {"status": "enabled"}}}
JSON
```
