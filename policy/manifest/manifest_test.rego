package manifest

import rego.v1

valid := {
	"project": {"name": "my-app", "level": 1},
	"zones": {"protected": {"paths": [".github/**", "harness.toml", "tests/critical/**", "lib/auth/**"]}},
	"alerts": {"channel": "github-issues"},
}

test_valid_manifest_passes if {
	count(deny) == 0 with input as valid
}

test_missing_name_fails if {
	"harness.toml: [project] name must be a non-empty string" in deny with input as object.remove(valid, ["project"])
}

test_empty_name_fails if {
	"harness.toml: [project] name must be a non-empty string" in deny with input as object.union(valid, {"project": {"name": "", "level": 1}})
}

test_level_out_of_range_fails if {
	"harness.toml: [project] level must be 1, 2, 3 or 4" in deny with input as object.union(valid, {"project": {"name": "a", "level": 5}})
}

test_level_as_string_fails if {
	"harness.toml: [project] level must be 1, 2, 3 or 4" in deny with input as object.union(valid, {"project": {"name": "a", "level": "1"}})
}

test_removing_a_protected_zone_fails if {
	m := object.union(valid, {"zones": {"protected": {"paths": ["harness.toml", "tests/critical/**"]}}})
	"harness.toml: [zones.protected] paths must include \".github/**\"" in deny with input as m
}

test_no_protected_zones_fails_three_times if {
	count([msg | some msg in deny; contains(msg, "[zones.protected]")]) == 3 with input as object.remove(valid, ["zones"])
}

test_mail_channel_fails if {
	"harness.toml: [alerts] channel must be \"github-issues\" (no mail password in the infrastructure)" in deny with input as object.union(valid, {"alerts": {"channel": "smtp"}})
}

test_missing_alerts_fails if {
	"harness.toml: an [alerts] section with channel = \"github-issues\" is required" in deny with input as object.remove(valid, ["alerts"])
}
