package daemon

import (
	"context"
	"errors"
	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/xray"
	"sync/atomic"
	"testing"
	"time"
)

type slowControl struct {
	config model.Desired
	calls  atomic.Int32
}

func (s *slowControl) Config(ctx context.Context, _ uint64) (model.Desired, error) {
	if s.calls.Add(1) == 1 {
		return s.config, nil
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
	}
	return model.Desired{}, control.ErrNetwork
}
func (s *slowControl) Snapshot(ctx context.Context, _ model.Snapshot) error {
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
	}
	return control.ErrNetwork
}
func TestSlowCloudNeverBlocksSamplingOrQuota(t *testing.T) {
	d, a, _, _ := fixture(t)
	d.Control = &slowControl{config: d.Config.Desired}
	heartbeats := 0
	d.Notify = func(n string) error {
		if n == "READY=1" {
			a.counter["alice@proxysetting"] = xray.Counter{Up: model.GiB + 1}
		}
		if n == "WATCHDOG=1" {
			heartbeats++
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if e := d.run(ctx, 5*time.Millisecond, 10*time.Millisecond, 20*time.Millisecond); e != nil {
		t.Fatal(e)
	}
	if heartbeats < 3 || !d.State.Users["alice"].Disabled || len(a.users) != 0 {
		t.Fatalf("slow remote stalled local quota: beats=%d disabled=%v", heartbeats, d.State.Users["alice"].Disabled)
	}
}
func TestRuntimeAPIFailureStopsXrayWithoutHeartbeat(t *testing.T) {
	d, a, _, events := fixture(t)
	beats := 0
	d.Notify = func(n string) error {
		if n == "WATCHDOG=1" {
			beats++
			if beats == 3 {
				a.bad = true
			}
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e := d.run(ctx, 5*time.Millisecond, time.Second, time.Second); !errors.Is(e, ErrLocal) {
		t.Fatal(e)
	}
	if (*events)[len(*events)-1] != "stop" || beats != 3 {
		t.Fatal("not fail-closed", *events)
	}
}
