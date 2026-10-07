package main

import "testing"

func TestRetentionPolicyValidation(t *testing.T) {
	for _, policy := range []string{"keep", "24h", "7d", "30d"} {
		if !validRetentionPolicy(policy) { t.Fatalf("validRetentionPolicy(%q) = false", policy) }
	}
	for _, policy := range []string{"1h", "forever", "", "90d"} {
		if validRetentionPolicy(policy) { t.Fatalf("validRetentionPolicy(%q) = true", policy) }
	}
}
