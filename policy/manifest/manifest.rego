# G0: rules every harness.toml must follow (README section 3). Input: the parsed harness.toml.
package manifest

import rego.v1

required_protected := {".github/**", "harness.toml", "tests/critical/**"}

protected := {p | some p in input.zones.protected.paths}

deny contains "harness.toml: [project] name must be a non-empty string" if {
	not valid_name
}

valid_name if {
	is_string(input.project.name)
	input.project.name != ""
}

deny contains "harness.toml: [project] level must be 1, 2, 3 or 4" if {
	not input.project.level in {1, 2, 3, 4}
}

deny contains msg if {
	some p in required_protected
	not p in protected
	msg := sprintf("harness.toml: [zones.protected] paths must include %q", [p])
}

deny contains "harness.toml: [alerts] channel must be \"github-issues\" (no mail password in the infrastructure)" if {
	input.alerts.channel != "github-issues"
}

deny contains "harness.toml: an [alerts] section with channel = \"github-issues\" is required" if {
	not input.alerts.channel
}
