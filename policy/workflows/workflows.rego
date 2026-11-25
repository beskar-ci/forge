# G0: rules every GitHub Actions workflow must follow. Input: one parsed workflow file.
package workflows

import rego.v1

deny contains "workflow: declare top-level permissions (least privilege, e.g. contents: read), widened job by job" if {
	not input.permissions
}

deny contains "workflow: permissions: write-all is not allowed" if {
	input.permissions == "write-all"
}

deny contains msg if {
	some name, job in input.jobs
	some step in job.steps
	ref := step.uses
	not pinned(ref)
	msg := sprintf("job %s: %q must be pinned to a full commit SHA (or a local ./ path)", [name, ref])
}

deny contains msg if {
	some name, job in input.jobs
	ref := job.uses
	not pinned(ref)
	msg := sprintf("job %s: %q must be pinned to a full commit SHA (or a local ./ path)", [name, ref])
}

pinned(ref) if startswith(ref, "./")

pinned(ref) if regex.match(`@[0-9a-f]{40}$`, ref)

pinned(ref) if {
	startswith(ref, "docker://")
	contains(ref, "@sha256:")
}
