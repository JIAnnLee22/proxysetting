package daemon

// This opt-in integration uses a digest-pinned real Xray binary, a local TLS1.3
// camouflage target and a local TCP echo destination; no external proxy traffic.
import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/install"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/usage"
	"proxysetting/agent/internal/xray"
	"testing"
	"time"
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
func realProcess(t *testing.T, bin, path string) *exec.Cmd {
	t.Helper()
	if e := install.TestXray(context.Background(), bin, path); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(bin, "run", "-config", path)
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}
func socksEcho(t *testing.T, port, dest int) net.Conn {
	t.Helper()
	c, e := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", fmtPort(port)), time.Second)
	if e != nil {
		t.Fatal(e)
	}
	_ = c.SetDeadline(time.Now().Add(4 * time.Second))
	_, e = c.Write([]byte{5, 1, 0})
	if e != nil {
		t.Fatal(e)
	}
	b := make([]byte, 2)
	if _, e = io.ReadFull(c, b); e != nil || b[1] != 0 {
		c.Close()
		t.Fatal("SOCKS greeting failed", e)
	}
	request := []byte{5, 1, 0, 1, 127, 0, 0, 1, 0, 0}
	binary.BigEndian.PutUint16(request[8:], uint16(dest))
	_, e = c.Write(request)
	if e != nil {
		t.Fatal(e)
	}
	b = make([]byte, 4)
	if _, e = io.ReadFull(c, b); e != nil || b[1] != 0 {
		c.Close()
		t.Fatal("SOCKS connect failed", e)
	}
	size := 0
	switch b[3] {
	case 1:
		size = 6
	case 4:
		size = 18
	case 3:
		one := make([]byte, 1)
		_, _ = io.ReadFull(c, one)
		size = int(one[0]) + 2
	}
	if _, e = io.CopyN(io.Discard, c, int64(size)); e != nil {
		t.Fatal(e)
	}
	return c
}
func fmtPort(p int) string {
	var b [6]byte
	i := len(b)
	for {
		i--
		b[i] = byte('0' + p%10)
		p /= 10
		if p == 0 {
			return string(b[i:])
		}
	}
}
func echoBytes(c net.Conn, n int) error {
	payload := make([]byte, n)
	for i := range payload {
		payload[i] = 'x'
	}
	if _, e := c.Write(payload); e != nil {
		return e
	}
	b := make([]byte, n)
	_, e := io.ReadFull(c, b)
	return e
}
func TestRealXrayRuntime(t *testing.T) {
	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("set XRAY_BIN to digest-verified Xray v26.3.27")
	}
	probe, e := net.Listen("tcp", model.APIAddress)
	if e != nil {
		t.Fatal("local API port occupied")
	}
	probe.Close()
	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	target.TLS = &tls.Config{MinVersion: tls.VersionTLS13, CurvePreferences: []tls.CurveID{tls.X25519}, NextProtos: []string{"h2", "http/1.1"}}
	target.StartTLS()
	defer target.Close()
	echo, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	root := t.TempDir()
	if e = state.Prepare(root); e != nil {
		t.Fatal(e)
	}
	private, public, short, e := install.Keys()
	if e != nil {
		t.Fatal(e)
	}
	port, socks := freePort(t), freePort(t)
	desired := model.Desired{Schema: 1, VPSID: "vps1", Revision: 1, Port: port, ServerName: "example.com", Users: []model.User{{ID: "alice", Email: "alice@proxysetting", UUID: "00000000-0000-4000-8000-000000000001", QuotaBytes: 128}}}
	c := model.Installed{Schema: 1, Port: port, ServerName: "example.com", PrivateKey: private, PublicKey: public, ShortID: short, VPSID: "vps1", Desired: desired}
	config := install.XrayConfig(c).(map[string]any)
	inbound := config["inbounds"].([]any)[1].(map[string]any)
	inbound["listen"] = "127.0.0.1"
	reality := inbound["streamSettings"].(map[string]any)["realitySettings"].(map[string]any)
	reality["target"] = target.Listener.Addr().String()
	path := filepath.Join(root, "config", "xray.json")
	if e = state.Save(path, config); e != nil {
		t.Fatal(e)
	}
	server := realProcess(t, bin, path)
	api, e := xray.New()
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		_, e = api.Health(ctx)
		cancel()
		if e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Xray API not ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	now := time.Date(2026, 9, 30, 15, 59, 50, 0, time.UTC)
	d := &Daemon{Root: root, Version: "v0.1.0", Config: c, State: usage.New(now), API: api, Control: &fakeControl{config: desired}, Save: state.Save, Now: func() time.Time { return now }, active: map[string]string{}}
	if e = d.Sample(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	clientConfig := map[string]any{"log": map[string]any{"loglevel": "none"}, "inbounds": []any{map[string]any{"listen": "127.0.0.1", "port": socks, "protocol": "socks", "settings": map[string]any{"auth": "noauth"}}}, "outbounds": []any{map[string]any{"protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": "127.0.0.1", "port": port, "users": []any{map[string]any{"id": desired.Users[0].UUID, "encryption": "none", "flow": "xtls-rprx-vision"}}}}}, "streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{"serverName": "example.com", "fingerprint": "chrome", "publicKey": public, "shortId": short}}}}}
	clientPath := filepath.Join(root, "config", "client.json")
	if e = state.Save(clientPath, clientConfig); e != nil {
		t.Fatal(e)
	}
	realProcess(t, bin, clientPath)
	time.Sleep(150 * time.Millisecond)
	old := socksEcho(t, socks, echo.Addr().(*net.TCPAddr).Port)
	defer old.Close()
	if e = echoBytes(old, 256); e != nil {
		t.Fatal("Reality traffic failed", e)
	}
	time.Sleep(50 * time.Millisecond)
	if e = d.Sample(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	used := d.State.Users["alice"]
	if used.Uplink == 0 || used.Downlink == 0 || !used.Disabled {
		t.Fatal("not metered/disabled", used)
	}
	users, e := api.Users(context.Background())
	if e != nil || len(users) != 0 {
		t.Fatal("user not dynamically removed", e)
	}
	if e = echoBytes(old, 32); e != nil {
		t.Fatal("existing session unexpectedly terminated", e)
	}
	if e = d.Sample(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if d.State.Users["alice"].Uplink <= used.Uplink {
		t.Fatal("old-session bytes lost")
	}
	blocked := socksEcho(t, socks, echo.Addr().(*net.TCPAddr).Port)
	_ = blocked.SetDeadline(time.Now().Add(time.Second))
	if e = echoBytes(blocked, 8); e == nil {
		blocked.Close()
		t.Fatal("new over-quota connection accepted")
	}
	blocked.Close()
	now = time.Date(2026, 9, 30, 16, 0, 1, 0, time.UTC)
	if e = d.Sample(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	users, e = api.Users(context.Background())
	if e != nil || len(users) != 1 || d.State.Month != "2026-10" {
		t.Fatal("month not restored", e)
	}
	fresh := socksEcho(t, socks, echo.Addr().(*net.TCPAddr).Port)
	defer fresh.Close()
	if e = echoBytes(fresh, 8); e != nil {
		t.Fatal("new-month connection blocked", e)
	}
	d.Control = &fakeControl{err: control.ErrNetwork}
	if e = d.Poll(context.Background()); e != nil {
		t.Fatal("Cloudflare outage failed cached quotas", e)
	}
	_ = server.Process.Kill()
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e = d.Sample(ctx, false); e == nil {
		t.Fatal("unexpected Xray crash not detected")
	}
}
