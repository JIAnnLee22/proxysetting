package upgrade

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
	"strings"
	"testing"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPinnedRepoDigestAndIndependentHandoff(t *testing.T) {
	root := t.TempDir()
	if e := state.Prepare(root); e != nil {
		t.Fatal(e)
	}
	if e := state.Atomic(filepath.Join(root, "config", "release.env"), []byte("RELEASE_REPO=owner/repo\n")); e != nil {
		t.Fatal(e)
	}
	script := "#!/bin/bash\nexit 0\n"
	h := sha256.Sum256([]byte(script))
	u := &model.Upgrade{Version: "v0.1.1", URL: "https://github.com/owner/repo/releases/download/v0.1.1/install.sh", SHA256: hex.EncodeToString(h[:])}
	downloads, calls := 0, 0
	m := New()
	m.HTTP.Transport = transport(func(*http.Request) (*http.Response, error) {
		downloads++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(script))}, nil
	})
	m.Exec = func(_ context.Context, n string, args ...string) error {
		calls++
		if n != "systemd-run" || !strings.Contains(strings.Join(args, " "), "bash "+filepath.Join(root, "state", "upgrade.sh")+" --upgrade --root "+root+" --version v0.1.1") {
			t.Fatal("bad handoff")
		}
		return nil
	}
	if e := m.Apply(context.Background(), root, "v0.1.0", u); e != nil {
		t.Fatal(e)
	}
	if downloads != 1 || calls != 1 {
		t.Fatal("not handed off")
	}
	b, _ := os.ReadFile(filepath.Join(root, "state", "upgrade.sh"))
	if string(b) != script {
		t.Fatal("saved wrong script")
	}
	u.SHA256 = strings.Repeat("0", 64)
	if e := m.Apply(context.Background(), root, "v0.1.0", u); e == nil || calls != 1 {
		t.Fatal("executed bad digest")
	}
	u.URL = "https://github.com/evil/repo/releases/download/v0.1.1/install.sh"
	if e := m.Apply(context.Background(), root, "v0.1.0", u); e == nil || downloads != 2 {
		t.Fatal("unpinned repository downloaded")
	}
}
