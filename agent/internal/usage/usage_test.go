package usage

import (
	"encoding/json"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/xray"
	"testing"
	"time"
)

func desired() model.Desired {
	return model.Desired{Schema: 1, VPSID: "vps1", Revision: 1, Port: 443, ServerName: "www.microsoft.com", Users: []model.User{{ID: "alice", Email: "alice@proxysetting", UUID: "00000000-0000-4000-8000-000000000001", QuotaBytes: model.GiB}}}
}
func at(s string) time.Time {
	t, e := time.Parse(time.RFC3339, s)
	if e != nil {
		panic(e)
	}
	return t
}
func sample(t *testing.T, s *State, now time.Time, up, down uint64, reset bool, d model.Desired) {
	t.Helper()
	if e := s.Sample(now, map[string]xray.Counter{"alice@proxysetting": {Up: up, Down: down}}, reset, d, "v0.1.0"); e != nil {
		t.Fatal(e)
	}
}
func TestCountersAndReset(t *testing.T) {
	now := at("2026-09-15T01:00:00Z")
	s := New(now)
	d := desired()
	sample(t, s, now, 100, 50, false, d)
	sample(t, s, now.Add(10*time.Second), 140, 80, false, d)
	if v := s.Users["alice"]; v.Uplink != 140 || v.Downlink != 80 {
		t.Fatal(v)
	}
	sample(t, s, now.Add(20*time.Second), 20, 10, false, d)  // independent counter rollback
	sample(t, s, now.Add(30*time.Second), 200, 100, true, d) // restarted, new counters may already exceed old ones
	if v := s.Users["alice"]; v.Uplink != 360 || v.Downlink != 190 {
		t.Fatal(v)
	}
	// Missing counters do not erase a baseline.
	if e := s.Sample(now.Add(40*time.Second), map[string]xray.Counter{}, false, d, "v0.1.0"); e != nil {
		t.Fatal(e)
	}
	sample(t, s, now.Add(50*time.Second), 210, 110, false, d)
	if v := s.Users["alice"]; v.Uplink != 370 || v.Downlink != 200 {
		t.Fatal(v)
	}
}
func TestQuotaRevokeRaise(t *testing.T) {
	now := at("2026-09-15T01:00:00Z")
	s := New(now)
	d := desired()
	sample(t, s, now, model.GiB-1, 1, false, d)
	if !s.Users["alice"].Disabled || len(s.Allowed(d)) != 0 {
		t.Fatal("quota not enforced")
	}
	// Removed users' established connections continue accruing traffic.
	sample(t, s, now.Add(10*time.Second), model.GiB+10, 20, false, d)
	d.Users[0].QuotaBytes = 2 * model.GiB
	s.Disable(d)
	if len(s.Allowed(d)) != 1 {
		t.Fatal("quota increase did not restore")
	}
	d.Users = []model.User{}
	s.Disable(d)
	if !s.Users["alice"].Disabled || len(s.Users) != 1 {
		t.Fatal("revoked history was lost")
	}
}
func TestBeijingRolloverNoCrossMonth(t *testing.T) {
	now := at("2026-09-30T15:59:55Z")
	s := New(now)
	d := desired()
	sample(t, s, now, model.GiB, 0, false, d)
	sample(t, s, at("2026-09-30T16:00:05Z"), model.GiB+99, 10, false, d)
	if s.Month != "2026-10" || s.Day != "2026-10-01" || s.Users["alice"].Uplink != 0 || s.Users["alice"].Disabled {
		t.Fatal(s)
	}
	if len(s.Pending) != 1 || s.Pending[0].Month != "2026-09" || s.Pending[0].Users[0].Uplink != model.GiB {
		t.Fatal(s.Pending)
	}
	sample(t, s, at("2026-09-30T16:00:15Z"), model.GiB+109, 20, false, d)
	if v := s.Users["alice"]; v.Uplink != 10 || v.Downlink != 10 {
		t.Fatal(v)
	}
	if e := s.Sample(now, nil, false, d, "v0.1.0"); e != ErrClock {
		t.Fatalf("clock rollback: %v", e)
	}
}
func TestMergeRemoteDirectionMaxNoRepeat(t *testing.T) {
	now := at("2026-09-15T01:00:00Z")
	s := New(now)
	d := desired()
	d.Usage = &model.RemoteUsage{Month: "2026-09", Users: []model.SnapshotUser{{ID: "alice", Uplink: 100, Downlink: 200}, {ID: "revoked", Uplink: 10, Downlink: 20, Disabled: true}}}
	if e := s.Ensure(d); e != nil {
		t.Fatal(e)
	}
	if e := s.Merge(now, d); e != nil {
		t.Fatal(e)
	}
	sample(t, s, now, 20, 30, false, d)
	for i := 0; i < 3; i++ {
		if e := s.Merge(now, d); e != nil {
			t.Fatal(e)
		}
	}
	if v := s.Users["alice"]; v.Uplink != 120 || v.Downlink != 230 {
		t.Fatal(v)
	}
	if !s.Users["revoked"].Disabled {
		t.Fatal("remote historical user authorized")
	}
	d.Usage.Users[0].Uplink = 500
	d.Usage.Users[0].Downlink = 100
	if e := s.Merge(now, d); e != nil {
		t.Fatal(e)
	}
	if v := s.Users["alice"]; v.Uplink != 500 || v.Downlink != 230 {
		t.Fatal(v)
	}
	// A reinstall on an empty root starts with Worker cumulative usage, not zero.
	s = New(now)
	d.Usage.Users[0].Uplink = model.GiB
	if e := s.Ensure(d); e != nil {
		t.Fatal(e)
	}
	if e := s.Merge(now, d); e != nil {
		t.Fatal(e)
	}
	if !s.Users["alice"].Disabled || len(s.Allowed(d)) != 0 {
		t.Fatal("reinstall reset quota")
	}
	d.Usage = nil
	if e := s.Merge(now, d); e != nil {
		t.Fatal(e)
	}
	if s.Users["alice"].Uplink != model.GiB {
		t.Fatal("absent usage reset local total")
	}
}
func TestMergeOldMonthIgnored(t *testing.T) {
	now := at("2026-09-30T16:00:01Z")
	s := New(now)
	d := desired()
	d.Usage = &model.RemoteUsage{Month: "2026-09", Users: []model.SnapshotUser{{ID: "alice", Uplink: model.GiB}}}
	if e := s.Ensure(d); e != nil {
		t.Fatal(e)
	}
	if e := s.Merge(now, d); e != nil {
		t.Fatal(e)
	}
	if s.Users["alice"].Uplink != 0 || len(s.Allowed(d)) != 1 {
		t.Fatal("old month leaked")
	}
}
func TestDurablePendingSequenceAndOverflow(t *testing.T) {
	now := at("2026-09-15T01:00:00Z")
	s := New(now)
	d := desired()
	sample(t, s, now, 10, 20, false, d)
	if e := s.Queue(1, "v0.1.0", "ready", ""); e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(s)
	var restored State
	if e := json.Unmarshal(b, &restored); e != nil {
		t.Fatal(e)
	}
	if e := restored.Validate(); e != nil {
		t.Fatal(e)
	}
	sample(t, &restored, now.Add(10*time.Second), 30, 50, false, d)
	if restored.Pending[0].Sequence != 1 || restored.Pending[0].Users[0].Uplink != 10 {
		t.Fatal("pending payload mutated")
	}
	restored.Pending = nil
	if e := restored.Queue(1, "v0.1.0", "ready", ""); e != nil {
		t.Fatal(e)
	}
	if restored.Sequence != 2 {
		t.Fatal(restored.Sequence)
	}
	restored.Sequence = model.MaxSafe
	if e := restored.Queue(1, "v0.1.0", "ready", ""); e != ErrState {
		t.Fatal("sequence overflow")
	}
	s.Users["alice"] = Entry{Uplink: model.MaxSafe}
	if e := s.Sample(now, map[string]xray.Counter{"alice@proxysetting": {Up: 1}}, false, d, "v0.1.0"); e != ErrState {
		t.Fatal("counter overflow")
	}
}
func TestPruneExpiredPending(t *testing.T) {
	s := New(at("2026-07-01T00:00:00Z"))
	_ = s.Queue(1, "v0.1.0", "ready", "")
	s.Prune(at("2026-09-15T00:00:00Z"))
	if len(s.Pending) != 0 || s.Sequence != 1 {
		t.Fatal(s)
	}
}
