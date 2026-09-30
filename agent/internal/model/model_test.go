package model

import (
	"strings"
	"testing"
)

func valid() Desired {
	return Desired{Schema: 1, VPSID: "vps1", Revision: 1, Port: 443, ServerName: "www.microsoft.com", Users: []User{{ID: "alice", Email: "alice@proxysetting", UUID: "00000000-0000-4000-8000-000000000001", QuotaBytes: GiB}}}
}
func TestDesiredValidation(t *testing.T) {
	for _, c := range []struct {
		name   string
		mutate func(*Desired)
	}{
		{"quota missing", func(d *Desired) { d.Users[0].QuotaBytes = 0 }}, {"overflow", func(d *Desired) { d.Users[0].QuotaBytes = MaxSafe + 1 }}, {"email", func(d *Desired) { d.Users[0].Email = "secret" }}, {"uuid", func(d *Desired) { d.Users[0].UUID = "secret" }}, {"duplicates", func(d *Desired) { d.Users = append(d.Users, d.Users[0]) }}, {"api collision", func(d *Desired) { d.Port = 10085 }}, {"dns", func(d *Desired) { d.ServerName = "127.0.0.1" }}, {"schema", func(d *Desired) { d.Schema = 2 }}, {"revision", func(d *Desired) { d.Revision = MaxSafe + 1 }}, {"remote overflow", func(d *Desired) {
			d.Usage = &RemoteUsage{Month: "2026-09", Users: []SnapshotUser{{ID: "alice", Uplink: MaxSafe, Downlink: 1}}}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := valid()
			c.mutate(&d)
			if e := d.Validate(); e != ErrConfig {
				t.Fatal(e)
			}
		})
	}
	if e := valid().Validate(); e != nil {
		t.Fatal(e)
	}
}
func TestControlURLs(t *testing.T) {
	for _, s := range []string{"http://control.example", "https://user:secret@control.example", "https://control.example?token=secret", "https://control.example/path", "https://control.example#secret"} {
		if ControlURL(s) == nil {
			t.Fatal("accepted unsafe URL")
		}
	}
	if ControlURL("https://control.example") != nil {
		t.Fatal("valid URL")
	}
}
func TestUpgradeURLs(t *testing.T) {
	u := Upgrade{Version: "v0.1.1", URL: "https://github.com/owner/repo/releases/download/v0.1.1/install.sh", SHA256: strings.Repeat("a", 64)}
	if e := ValidateUpgrade(&u); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{"https://evil.example/owner/repo/releases/download/v0.1.1/install.sh", "https://github.com/owner/repo/releases/download/latest/install.sh", "https://github.com/owner/repo/releases/download/v0.1.1/install.sh/extra", "https://github.com/owner/repo/releases/download/v0.1.1/install.sh?secret=x", "https://github.com/owner/repo/releases/download/v0.1.1/%69nstall.sh"} {
		u.URL = s
		if ValidateUpgrade(&u) == nil {
			t.Fatal("unsafe upgrade URL")
		}
	}
}
