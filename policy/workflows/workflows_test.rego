package workflows

import rego.v1

sha := "11d5960a326750d5838078e36cf38b85af677262"

good := {
	"permissions": {"contents": "read"},
	"jobs": {
		"build": {"steps": [{"uses": sprintf("actions/checkout@%s", [sha])}, {"run": "make"}, {"uses": "./local-action"}]},
		"reuse": {"uses": sprintf("org/repo/.github/workflows/x.yml@%s", [sha])},
	},
}

test_pinned_least_privilege_workflow_passes if {
	count(deny) == 0 with input as good
}

test_missing_permissions_fails if {
	"workflow: declare top-level permissions (least privilege, e.g. contents: read), widened job by job" in deny with input as object.remove(good, ["permissions"])
}

test_write_all_fails if {
	"workflow: permissions: write-all is not allowed" in deny with input as object.union(good, {"permissions": "write-all"})
}

test_tag_reference_fails if {
	w := object.union(good, {"jobs": {"build": {"steps": [{"uses": "actions/checkout@v4"}]}}})
	"job build: \"actions/checkout@v4\" must be pinned to a full commit SHA (or a local ./ path)" in deny with input as w
}

test_branch_reference_on_reusable_workflow_fails if {
	w := object.union(good, {"jobs": {"reuse": {"uses": "org/repo/.github/workflows/x.yml@main"}}})
	count(deny) == 1 with input as w
}

test_short_sha_fails if {
	w := object.union(good, {"jobs": {"build": {"steps": [{"uses": "actions/checkout@11d5960"}]}}})
	count(deny) == 1 with input as w
}

test_docker_image_needs_a_digest if {
	tagged := object.union(good, {"jobs": {"build": {"steps": [{"uses": "docker://alpine:3"}]}}})
	digested := object.union(good, {"jobs": {"build": {"steps": [{"uses": "docker://alpine:3@sha256:abc"}]}}})
	count(deny) == 1 with input as tagged
	count(deny) == 0 with input as digested
}

test_run_steps_and_plain_jobs_are_not_flagged if {
	w := {"permissions": {}, "jobs": {"plain": {"runs-on": "ubuntu-latest", "steps": [{"run": "echo hi"}, {"name": "x", "run": "make"}]}}}
	count(deny) == 0 with input as w
}

