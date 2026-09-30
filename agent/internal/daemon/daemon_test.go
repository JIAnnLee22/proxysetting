package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/usage"
	"proxysetting/agent/internal/xray"
)

type fakeAPI struct {
	users   map[string]model.User
	counter map[string]xray.Counter
	events  *[]string
	bad     bool
	uptime  uint32
}

func (f *fakeAPI) Health(context.Context) (uint32, error) {
	if f.bad {
		return 0, xray.ErrAPI
	}
	return f.uptime, nil
}
func (f *fakeAPI) Stats(context.Context) (map[string]xray.Counter, error) {
	if f.bad {
		return nil, xray.ErrAPI
	}
	return f.counter, nil
}
func (f *fakeAPI) Users(context.Context) ([]string, error) {
	out := []string{}
	for e := range f.users {
		out = append(out, e)
	}
	return out, nil
}
func (f *fakeAPI) Add(_ context.Context, u model.User) error {
	*f.events = append(*f.events, "add")
	f.users[u.Email] = u
	return nil
}
func (f *fakeAPI) Remove(_ context.Context, email string) error {
	*f.events = append(*f.events, "remove")
	delete(f.users, email)
	return nil
}

type fakeControl struct {
	config    model.Desired
	err       error
	sent      []model.Snapshot
	uploadErr error
}

func (f *fakeControl) Config(context.Context, uint64) (model.Desired, error) { return f.config, f.err }
func (f *fakeControl) Snapshot(_ context.Context, p model.Snapshot) error {
	b, _ := json.Marshal(p)
	var copy model.Snapshot
	_ = json.Unmarshal(b, &copy)
	f.sent = append(f.sent, copy)
	return f.uploadErr
}
func fixture(t *testing.T) (*Daemon, *fakeAPI, *fakeControl, *[]string) {
	t.Helper()
	now := time.Date(2026, 9, 15, 1, 0, 0, 0, time.UTC)
	events := []string{}
	config := model.Desired{Schema: 1, VPSID: "vps1", Revision: 1, Port: 443, ServerName: "www.microsoft.com", Users: []model.User{{ID: "alice", Email: "alice@proxysetting", UUID: "00000000-0000-4000-8000-000000000001", QuotaBytes: model.GiB}}}
	root := t.TempDir()
	if e := state.Prepare(root); e != nil {
		t.Fatal(e)
	}
	api := &fakeAPI{users: map[string]model.User{}, counter: map[string]xray.Counter{}, events: &events, uptime: 100}
	client := &fakeControl{config: config}
	d := &Daemon{Root: root, Version: "v0.1.0", Config: model.Installed{VPSID: "vps1", Port: 443, ServerName: config.ServerName, Desired: config}, State: usage.New(now), API: api, Control: client, Now: func() time.Time { return now }, active: map[string]string{}, Save: func(path string, v any) error { events = append(events, "save"); return state.Save(path, v) }, Notify: func(s string) error { events = append(events, s); return nil }, StopXray: func(context.Context) error { events = append(events, "stop"); return nil }}
	return d, api, client, &events
}
func TestDurableBeforeAddRemoveAndStartupRebuild(t *testing.T) {
	d, a, _, events := fixture(t)
	a.users["rogue@proxysetting"] = model.User{}
	if e := d.Sample(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	if (*events)[0] != "save" || (*events)[1] != "remove" || (*events)[2] != "add" {
		t.Fatal(*events)
	}
	*events = nil
	a.counter["alice@proxysetting"] = xray.Counter{Up: model.GiB}
	if e := d.Sample(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if (*events)[0] != "save" || (*events)[1] != "remove" || len(a.users) != 0 {
		t.Fatal(*events, a.users)
	}
	a.counter["alice@proxysetting"] = xray.Counter{Up: model.GiB + 10}
	if e := d.Sample(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if d.State.Users["alice"].Uplink != model.GiB+10 {
		t.Fatal("old sessions unaccounted")
	}
}
func TestPersistFailureDoesNotGrantOrHeartbeat(t *testing.T) {
	d, a, _, events := fixture(t)
	d.Save = func(string, any) error { return state.ErrIO }
	if e := d.Sample(context.Background(), true); e != state.ErrIO || len(a.users) != 0 || len(*events) != 0 {
		t.Fatal(e, *events)
	}
}
func TestPollUsageSameRevisionNoAdditiveMerge(t *testing.T) {
	d, a, c, _ := fixture(t)
	if e := d.Sample(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	a.counter["alice@proxysetting"] = xray.Counter{Up: 100, Down: 200}
	c.config.Usage = &model.RemoteUsage{Month: "2026-09", Users: []model.SnapshotUser{{ID: "alice", Uplink: model.GiB}}}
	if e := d.Poll(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := d.Poll(context.Background()); e != nil {
		t.Fatal(e)
	}
	if v := d.State.Users["alice"]; v.Uplink != model.GiB || v.Downlink != 200 || !v.Disabled || len(a.users) != 0 {
		t.Fatal(v)
	}
	var s usage.State
	if e := state.Load(filepath.Join(d.Root, "state", "usage.json"), &s); e != nil {
		t.Fatal(e)
	}
	if s.Users["alice"].Uplink != model.GiB {
		t.Fatal("remote merge not durable")
	}
}
func TestPollQuotaUUIDAndValidation(t *testing.T) {
	d, a, c, _ := fixture(t)
	if e := d.Sample(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	c.config.Users = append([]model.User(nil), c.config.Users...)
	c.config.Revision = 2
	c.config.Users[0].UUID = "00000000-0000-4000-8000-000000000002"
	if e := d.Poll(context.Background()); e != nil {
		t.Fatal(e)
	}
	if a.users["alice@proxysetting"].UUID != c.config.Users[0].UUID {
		t.Fatal("UUID not replaced")
	}
	c.config.Port = 444
	if e := d.Poll(context.Background()); e != model.ErrConfig {
		t.Fatal(e)
	}
	c.err = control.ErrNetwork
	if e := d.Poll(context.Background()); e != nil || len(a.users) != 1 {
		t.Fatal("offline grant lost")
	}
	c.err = control.ErrAuth
	if e := d.Poll(context.Background()); e != control.ErrAuth {
		t.Fatal(e)
	}
}
func TestUploadImmutableOfflineAndAckRestart(t *testing.T) {
	d, _, c, _ := fixture(t)
	if e := d.Sample(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	c.uploadErr = control.ErrNetwork
	if e := d.Upload(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(d.State.Pending) != 1 || d.State.Sequence != 1 {
		t.Fatal("pending not durable")
	}
	before, _ := json.Marshal(c.sent[0])
	d.State.Users["alice"] = usage.Entry{Uplink: 42}
	var restored usage.State
	if e := state.Load(filepath.Join(d.Root, "state", "usage.json"), &restored); e != nil {
		t.Fatal(e)
	}
	d.State = &restored
	if e := d.Upload(context.Background()); e != nil {
		t.Fatal(e)
	}
	after, _ := json.Marshal(c.sent[1])
	if string(before) != string(after) {
		t.Fatal("retry body changed")
	}
	c.uploadErr = nil
	if e := d.Upload(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(d.State.Pending) != 0 || d.State.Sequence != 1 {
		t.Fatal("ack not durable")
	}
	if e := d.Upload(context.Background()); e != nil {
		t.Fatal(e)
	}
	if d.State.Sequence != 2 || c.sent[len(c.sent)-1].Version != "v0.1.0" || c.sent[len(c.sent)-1].Status != "ready" {
		t.Fatal("snapshot contract")
	}
	c.uploadErr = control.ErrAuth
	if e := d.Upload(context.Background()); e != control.ErrAuth {
		t.Fatal(e)
	}
}
func TestRunReadyFinalSampleThenStop(t *testing.T) {
	d, a, _, events := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	d.Notify = func(s string) error {
		*events = append(*events, s)
		if s == "READY=1" {
			a.counter["alice@proxysetting"] = xray.Counter{Up: 88}
			cancel()
		}
		return nil
	}
	if e := d.Run(ctx); e != nil {
		t.Fatal(e)
	}
	if d.State.Users["alice"].Uplink != 88 || d.State.Ready || (*events)[len(*events)-1] != "stop" {
		t.Fatal(*events, d.State)
	}
	ready := -1
	for i, e := range *events {
		if e == "READY=1" {
			ready = i
		}
	}
	if ready < 2 || (*events)[ready-1] != "save" {
		t.Fatal("READY before persistence")
	}
}
func TestRunRevocationFatalStopsAndNoReady(t *testing.T) {
	d, _, c, events := fixture(t)
	c.err = control.ErrAuth
	if e := d.Run(context.Background()); !errors.Is(e, control.ErrAuth) {
		t.Fatal(e)
	}
	if (*events)[len(*events)-1] != "stop" {
		t.Fatal("Xray not stopped")
	}
	for _, e := range *events {
		if strings.Contains(e, "READY=1") {
			t.Fatal("unauthorized READY")
		}
	}
}
