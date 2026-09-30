// Package install prepares an installation but never starts services or downloads
// executable binaries. The root installer owns release verification and systemd units.
package install

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/usage"
)

var ErrInstall = errors.New("installation failed; enrollment may require a new token")
var ErrTLS = errors.New("Reality target failed verified TLS 1.3 test")
var ErrPort = errors.New("required listen port unavailable")

type Options struct {
	Root, ControlURL, Token, Address, ServerName, Version string
	Port                                                  int
}
type Hooks struct {
	TestTLS  func(context.Context, string) error
	TestXray func(context.Context, string, string) error
	Enroll   func(context.Context, control.Register) (control.Enrollment, error)
}

func TestTLS(ctx context.Context, name string) error {
	d := tls.Dialer{NetDialer: &net.Dialer{Timeout: 10 * time.Second}, Config: &tls.Config{ServerName: name, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13}}
	conn, e := d.DialContext(ctx, "tcp", net.JoinHostPort(name, "443"))
	if e != nil {
		return ErrTLS
	}
	defer conn.Close()
	t, ok := conn.(*tls.Conn)
	if !ok || t.ConnectionState().Version != tls.VersionTLS13 {
		return ErrTLS
	}
	return nil
}
func TestXray(ctx context.Context, bin, config string) error {
	out, e := exec.CommandContext(ctx, bin, "version").Output()
	// Exact version token, not a substring (26.3.270 must not pass).
	fields := strings.Fields(string(out))
	if e != nil || len(fields) < 2 || fields[0] != "Xray" || fields[1] != model.XrayVersion {
		return errors.New("incorrect Xray version")
	}
	c := exec.CommandContext(ctx, bin, "run", "-test", "-config", config)
	c.Stdout = io.Discard
	c.Stderr = io.Discard // never expose private keys in Xray diagnostics
	if e = c.Run(); e != nil {
		return errors.New("Xray configuration test failed")
	}
	return nil
}
func CheckPorts(port int) error {
	a, e := net.Listen("tcp", model.APIAddress)
	if e != nil {
		return ErrPort
	}
	defer a.Close()
	b, e := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if e != nil {
		return ErrPort
	}
	defer b.Close()
	return nil
}
func Keys() (private, public, short string, e error) {
	k, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		return "", "", "", ErrInstall
	}
	b := make([]byte, 8)
	if _, e = rand.Read(b); e != nil {
		return "", "", "", ErrInstall
	}
	return base64.RawURLEncoding.EncodeToString(k.Bytes()), base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()), hex.EncodeToString(b), nil
}

// XrayConfig intentionally contains zero static clients. Runtime grants are restored
// by HandlerService only after the state is durable; a restarted Xray is fail-closed.
func XrayConfig(c model.Installed) any {
	return map[string]any{
		"log":    map[string]any{"loglevel": "none"},
		"api":    map[string]any{"tag": "api", "services": []string{"HandlerService", "StatsService"}},
		"stats":  map[string]any{},
		"policy": map[string]any{"levels": map[string]any{"0": map[string]any{"statsUserUplink": true, "statsUserDownlink": true}}},
		"inbounds": []any{
			map[string]any{"tag": "api-in", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": map[string]any{"address": "127.0.0.1"}},
			map[string]any{"tag": model.InboundTag, "listen": "::", "port": c.Port, "protocol": "vless", "settings": map[string]any{"clients": []any{}, "decryption": "none"}, "streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{"show": false, "target": net.JoinHostPort(c.ServerName, "443"), "xver": 0, "serverNames": []string{c.ServerName}, "privateKey": c.PrivateKey, "shortIds": []string{c.ShortID}}}},
		},
		"outbounds": []any{map[string]any{"protocol": "freedom", "tag": "direct"}},
		"routing":   map[string]any{"rules": []any{map[string]any{"type": "field", "inboundTag": []string{"api-in"}, "outboundTag": "api"}}},
	}
}
func Install(ctx context.Context, o Options, h Hooks) error {
	root, e := state.Root(o.Root)
	if e != nil {
		return e
	}
	if model.ControlURL(o.ControlURL) != nil || !model.ValidSecret(o.Token) || !model.PublicIP(o.Address) || o.Port < 1 || o.Port > 65535 || o.Port == 10085 || !model.ValidDNS(o.ServerName) || !model.ValidVersion(o.Version) {
		return model.ErrConfig
	}
	if e = state.Prepare(root); e != nil {
		return e
	}
	lock, e := state.Lock(root)
	if e != nil {
		return e
	}
	defer lock.Close()
	config := filepath.Join(root, "config", "agent.json")
	if _, e = os.Lstat(config); !errors.Is(e, os.ErrNotExist) {
		return errors.New("installation already exists; use upgrade or explicit re-enrollment after backup")
	}
	usagePath := filepath.Join(root, "state", "usage.json")
	if _, e = os.Lstat(usagePath); !errors.Is(e, os.ErrNotExist) {
		return ErrInstall
	}
	if e = CheckPorts(o.Port); e != nil {
		return e
	}
	if h.TestTLS == nil {
		h.TestTLS = TestTLS
	}
	if h.TestXray == nil {
		h.TestXray = TestXray
	}
	if e = h.TestTLS(ctx, o.ServerName); e != nil {
		return ErrTLS
	}
	private, public, short, e := Keys()
	if e != nil {
		return e
	}
	c := model.Installed{Schema: model.Schema, ControlURL: strings.TrimRight(o.ControlURL, "/"), Address: o.Address, Port: o.Port, ServerName: o.ServerName, PrivateKey: private, PublicKey: public, ShortID: short}
	// Persist the only copy of the private key BEFORE consuming the one-use token.
	// A failed installation leaves no valid agent.json; installer should back up/remove
	// this partial config and obtain a new token, never blindly repeat enrollment.
	xp := filepath.Join(root, "config", "xray.json")
	if e = state.Save(xp, XrayConfig(c)); e != nil {
		return e
	}
	if e = h.TestXray(ctx, filepath.Join(root, "current", "bin", "xray"), xp); e != nil {
		return e
	}
	if h.Enroll == nil {
		client, e := control.New(c.ControlURL, "")
		if e != nil {
			return e
		}
		h.Enroll = client.Enroll
	}
	r, e := h.Enroll(ctx, control.Register{Token: o.Token, Address: o.Address, Port: o.Port, PublicKey: public, ShortID: short, ServerName: o.ServerName, Version: o.Version})
	if e != nil {
		return ErrInstall
	}
	c.VPSID = r.VPSID
	c.Credential = r.Credential
	c.Desired = r.Config
	if e = c.Validate(); e != nil {
		return model.ErrConfig
	}
	// Never overwrite a previous billing state. Re-enrollment/rollback requires
	// an explicit installer backup/migration, not a fresh zero-month reset.
	s := usage.New(time.Now())
	if e = s.Ensure(c.Desired); e != nil {
		return e
	}
	if e = s.Merge(time.Now(), c.Desired); e != nil {
		return e
	}
	if e = state.Save(usagePath, s); e != nil {
		return e
	}
	if e = state.Save(config, c); e != nil {
		return e
	}
	return nil
}
