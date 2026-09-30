// Package upgrade downloads a hash-verified, version-fixed release installer and
// hands off to a separate transient systemd service. It never replaces agent/Xray.
package upgrade

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
)

var ErrUpgrade = errors.New("verified upgrade handoff failed")

const MaxScript = 1 << 20

type Runner func(context.Context, string, ...string) error
type Manager struct {
	HTTP *http.Client
	Exec Runner
}

func New() *Manager {
	return &Manager{HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !AllowedDownload(req.URL) {
			return ErrUpgrade
		}
		return nil
	}}, Exec: func(ctx context.Context, name string, args ...string) error {
		c := exec.CommandContext(ctx, name, args...)
		c.Stdout = io.Discard
		c.Stderr = io.Discard
		if e := c.Run(); e != nil {
			return ErrUpgrade
		}
		return nil
	}}
}
func AllowedDownload(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Host == "github.com" || u.Host == "release-assets.githubusercontent.com" || u.Host == "objects.githubusercontent.com"
}
func (m *Manager) Apply(ctx context.Context, root, current string, u *model.Upgrade) error {
	if u == nil || u.Version == current {
		return nil
	}
	if model.ValidateUpgrade(u) != nil {
		return model.ErrConfig
	}
	if _, e := state.Root(root); e != nil {
		return e
	}
	// Bind the installer URL to the locally pinned repository before downloading
	// or executing script bytes; a valid hash alone does not confer trust.
	envPath := filepath.Join(root, "config", "release.env")
	st, e := os.Lstat(envPath)
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1024 {
		return ErrUpgrade
	}
	b, e := os.ReadFile(envPath)
	if e != nil {
		return ErrUpgrade
	}
	repo := ""
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "RELEASE_REPO=") {
			if repo != "" {
				return ErrUpgrade
			}
			repo = strings.TrimPrefix(line, "RELEASE_REPO=")
		}
	}
	if repo == "" || u.URL != "https://github.com/"+repo+"/releases/download/"+u.Version+"/install.sh" {
		return ErrUpgrade
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.URL, nil)
	if e != nil {
		return ErrUpgrade
	}
	resp, e := m.HTTP.Do(req)
	if e != nil {
		return ErrUpgrade
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ErrUpgrade
	}
	b, e = io.ReadAll(io.LimitReader(resp.Body, MaxScript+1))
	if e != nil || len(b) == 0 || len(b) > MaxScript {
		return ErrUpgrade
	}
	hash := sha256.Sum256(b)
	if !strings.EqualFold(hex.EncodeToString(hash[:]), u.SHA256) {
		return ErrUpgrade
	}
	path := filepath.Join(root, "state", "upgrade.sh")
	if e = state.Atomic(path, b); e != nil {
		return e
	}
	// Fixed argv, not a shell command; --root is also forwarded to the installer.
	// --collect releases the unit name after success/failure, permitting a retry.
	if e = m.Exec(ctx, "systemd-run", "--unit", "proxysetting-upgrade", "--collect", "--property=Type=exec", "--", "bash", path, "--upgrade", "--root", root, "--version", u.Version); e != nil {
		return ErrUpgrade
	}
	return nil
}
