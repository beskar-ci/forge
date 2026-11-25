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

deny contains msg if {
	some name, job in input.jobs
	image := image_of(job.container)
	not contains(image, "@sha256:")
	msg := sprintf("job %s: container image %q must be pinned by digest (@sha256:...)", [name, image])
}

deny contains msg if {
	some name, job in input.jobs
	some service, spec in job.services
	image := image_of(spec)
	not contains(image, "@sha256:")
	msg := sprintf("job %s: service %s image %q must be pinned by digest (@sha256:...)", [name, service, image])
}

# `container:` and services accept a plain image string or an object with `image`.
image_of(c) := c if is_string(c)

image_of(c) := c.image if is_object(c)

pinned(ref) if startswith(ref, "./")

pinned(ref) if regex.match(`@[0-9a-f]{40}$`, ref)

pinned(ref) if {
	startswith(ref, "docker://")
	contains(ref, "@sha256:")
}
