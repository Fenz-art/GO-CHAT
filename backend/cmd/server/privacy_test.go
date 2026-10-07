package main

import "testing"

func TestVisibilityPolicyValidation(t *testing.T) {
	for _, value := range []string{"everyone", "direct_contacts", "nobody"} {
		if !validVisibility(value) { t.Fatalf("validVisibility(%q) = false", value) }
	}
	for _, value := range []string{"contacts", "public", ""} {
		if validVisibility(value) { t.Fatalf("validVisibility(%q) = true", value) }
	}
}

func TestQuietHourParsingAndFormatting(t *testing.T) {
	value := "22:05"
	parsed, err := parseQuietHour(&value)
	if err != nil { t.Fatalf("parseQuietHour() error = %v", err) }
	if got := quietHourString(parsed); got != value { t.Fatalf("quietHourString() = %q, want %q", got, value) }
	invalid := "25:00"
	if _, err := parseQuietHour(&invalid); err == nil { t.Fatal("parseQuietHour() accepted an invalid clock time") }
	unset, err := parseQuietHour(nil)
	if err != nil || quietHourString(unset) != "" { t.Fatal("unset quiet hour did not remain empty") }
}
