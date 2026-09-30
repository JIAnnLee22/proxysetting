package install

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/usage"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
func opts(t *testing.T) Options {
	return Options{Root: t.TempDir(), ControlURL: "https://control.example", Token: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), Address: "203.0.113.1", Port: freePort(t), ServerName: "www.microsoft.com", Version: "v0.1.0"}
}
func TestInstallPersistsSecretsLocallyAndWorkerUsage(t *testing.T) {
	o := opts(t)
	called := 0
	h := Hooks{TestTLS: func(context.Context, string) error { return nil }, TestXray: func(context.Context, string, string) error { return nil }, Enroll: func(_ context.Context, r control.Register) (control.Enrollment, error) {
		called++
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "privateKey") {
			t.Fatal("private key in register")
		}
		month, _ := model.Calendar(time.Now())
		return control.Enrollment{VPSID: "vps1", Credential: o.Token, Config: model.Desired{Schema: 1, VPSID: "vps1", Revision: 1, Port: o.Port, ServerName: o.ServerName, Users: []model.User{{ID: "alice", Email: "alice@proxysetting", UUID: "00000000-0000-4000-8000-000000000001", QuotaBytes: model.GiB}}, Usage: &model.RemoteUsage{Month: month, Users: []model.SnapshotUser{{ID: "alice", Uplink: model.GiB, Disabled: true}}}}}, nil
	}}
	if e := Install(context.Background(), o, h); e != nil {
		t.Fatal(e)
	}
	var c model.Installed
	if e := state.Load(filepath.Join(o.Root, "config", "agent.json"), &c); e != nil {
		t.Fatal(e)
	}
	if e := c.Validate(); e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"config/agent.json", "config/xray.json", "state/usage.json"} {
		st, e := os.Stat(filepath.Join(o.Root, p))
		if e != nil || st.Mode().Perm() != 0600 {
			t.Fatalf("mode: %s", p)
		}
	}
	var s usage.State
	if e := state.Load(filepath.Join(o.Root, "state", "usage.json"), &s); e != nil {
		t.Fatal(e)
	}
	if !s.Users["alice"].Disabled || s.Users["alice"].Uplink != model.GiB {
		t.Fatal("reinstall would reset quota")
	}
	if e := Install(context.Background(), o, h); e == nil || called != 1 {
		t.Fatal("enrollment retried")
	}
	b, e := os.ReadFile(filepath.Join(o.Root, "config", "xray.json"))
	if e != nil {
		t.Fatal(e)
	}
	var config struct {
		Inbounds []struct {
			Tag            string
			Listen         string
			Port           int
			Settings       struct{ Clients []any }
			StreamSettings struct{ RealitySettings struct{ PrivateKey string } }
		}
	}
	if e = json.Unmarshal(b, &config); e != nil {
		t.Fatal(e)
	}
	if config.Inbounds[0].Listen != "127.0.0.1" || config.Inbounds[0].Port != 10085 || len(config.Inbounds[1].Settings.Clients) != 0 || config.Inbounds[1].StreamSettings.RealitySettings.PrivateKey != c.PrivateKey {
		t.Fatal("unsafe Xray config")
	}
}
func TestTLSFailureNeverEnrolls(t *testing.T) {
	o := opts(t)
	calls := 0
	e := Install(context.Background(), o, Hooks{TestTLS: func(context.Context, string) error { return errors.New("secret") }, Enroll: func(context.Context, control.Register) (control.Enrollment, error) {
		calls++
		return control.Enrollment{}, nil
	}})
	if e != ErrTLS || calls != 0 {
		t.Fatal(e, calls)
	}
}
func TestPortsRejectCollision(t *testing.T) {
	l, e := net.Listen("tcp", model.APIAddress)
	if e != nil {
		t.Skip("API port already occupied")
	}
	defer l.Close()
	if e = CheckPorts(freePort(t)); e != ErrPort {
		t.Fatal(e)
	}
}
func TestPrivateKeyFormats(t *testing.T) {
	a, b, s, e := Keys()
	if e != nil || len(a) != 43 || len(b) != 43 || len(s) != 16 || a == b {
		t.Fatal("bad Reality key formats")
	}
}
