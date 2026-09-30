// Package daemon runs fail-closed accounting. Files are saved before access changes;
// only a successfully persisted sample and reconciled users feed the watchdog.
package daemon

import (
	"context"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"time"

	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/notify"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/upgrade"
	"proxysetting/agent/internal/usage"
	"proxysetting/agent/internal/xray"
)

var ErrLocal = errors.New("local accounting unavailable; stopping service")
var ErrHealth = errors.New("agent is not ready")

type Control interface {
	Config(context.Context, uint64) (model.Desired, error)
	Snapshot(context.Context, model.Snapshot) error
}
type Upgrader interface {
	Apply(context.Context, string, string, *model.Upgrade) error
}
type Daemon struct {
	Root     string
	Version  string
	Config   model.Installed
	State    *usage.State
	API      xray.API
	Control  Control
	Upgrade  Upgrader
	Save     func(string, any) error
	Notify   func(string) error
	StopXray func(context.Context) error
	Now      func() time.Time
	Error    string // whitelist only, no raw errors
	active   map[string]string
}

func Load(root, version string, api xray.API) (*Daemon, error) {
	root, e := state.Root(root)
	if e != nil {
		return nil, e
	}
	var c model.Installed
	if e = state.Load(filepath.Join(root, "config", "agent.json"), &c); e != nil {
		return nil, e
	}
	if e = c.Validate(); e != nil {
		return nil, e
	}
	var s usage.State
	if e = state.Load(filepath.Join(root, "state", "usage.json"), &s); e != nil {
		return nil, e
	} // never zero quotas on missing/corrupt state
	if e = s.Validate(); e != nil {
		return nil, e
	}
	client, e := control.New(c.ControlURL, c.Credential)
	if e != nil {
		return nil, e
	}
	d := &Daemon{Root: root, Version: version, Config: c, State: &s, API: api, Control: client, Upgrade: upgrade.New(), Save: state.Save, Notify: notify.Send, Now: time.Now, active: map[string]string{}}
	d.StopXray = func(ctx context.Context) error {
		cmd := exec.CommandContext(ctx, "systemctl", "stop", "--no-block", "proxysetting-xray.service")
		if e := cmd.Run(); e != nil {
			return ErrLocal
		}
		return nil
	}
	return d, nil
}
func (d *Daemon) persist() error {
	return d.Save(filepath.Join(d.Root, "state", "usage.json"), d.State)
}
func (d *Daemon) Reconcile(ctx context.Context, clear bool) error {
	live, e := d.API.Users(ctx)
	if e != nil {
		return xray.ErrAPI
	}
	allowed := d.State.Allowed(d.Config.Desired)
	present := map[string]bool{}
	// Remove unauthorized users first, including unknown entries left by external
	// API callers. Startup removes every existing user to guarantee current UUIDs.
	for _, email := range live {
		u, ok := allowed[email]
		if clear || !ok || d.active[email] != "" && d.active[email] != u.UUID {
			if e = d.API.Remove(ctx, email); e != nil {
				return xray.ErrAPI
			}
			delete(d.active, email)
		} else {
			present[email] = true
			d.active[email] = u.UUID
		}
	}
	for email, u := range allowed {
		if !present[email] {
			if e = d.API.Add(ctx, u); e != nil {
				return xray.ErrAPI
			}
		}
		d.active[email] = u.UUID
	}
	return nil
}
func (d *Daemon) Sample(ctx context.Context, clear bool) error {
	// One bounded transaction includes health, counters, persistence, and grants.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	uptime, e := d.API.Health(ctx)
	if e != nil {
		return xray.ErrAPI
	}
	counters, e := d.API.Stats(ctx)
	if e != nil {
		return xray.ErrAPI
	}
	now := d.Now()
	start := now.Unix() - int64(uptime)
	reset := d.State.XrayStart != 0 && math.Abs(float64(start-d.State.XrayStart)) > 3
	if e = d.State.Sample(now, counters, reset, d.Config.Desired, d.Version); e != nil {
		return e
	}
	d.State.XrayStart = start
	d.State.Ready = false
	if e = d.persist(); e != nil {
		return e
	}
	if e = d.Reconcile(ctx, clear); e != nil {
		return e
	}
	d.State.Ready = true
	if e = d.persist(); e != nil {
		return e
	}
	return nil
}
func (d *Daemon) Poll(ctx context.Context) error {
	next, e := d.Control.Config(ctx, d.Config.Desired.Revision)
	return d.acceptConfig(ctx, next, e)
}
func (d *Daemon) acceptConfig(ctx context.Context, next model.Desired, e error) error {
	if e != nil {
		if errors.Is(e, control.ErrAuth) {
			return e
		}
		d.Error = control.Safe(e)
		return nil // cached quotas on network/5xx and malformed responses
	}
	if e = next.Matches(d.Config); e != nil {
		return e
	} // fixed metadata mismatch is fatal
	// Usage advances independently of configuration revision.
	a, b := next, d.Config.Desired
	a.Usage = nil
	b.Usage = nil
	if next.Revision == d.Config.Desired.Revision && !reflect.DeepEqual(a, b) {
		return model.ErrConfig
	}
	// Account local deltas before the cumulative max merge (never additive).
	if !reflect.DeepEqual(next, d.Config.Desired) {
		if e = d.Sample(ctx, false); e != nil {
			return e
		}
		if e = d.State.Ensure(next); e != nil {
			return e
		}
		if e = d.State.Merge(d.Now(), next); e != nil {
			return e
		}
		c := d.Config
		c.Desired = next
		if e = d.Save(filepath.Join(d.Root, "config", "agent.json"), c); e != nil {
			return e
		}
		d.Config = c
		d.State.Ready = false
		if e = d.persist(); e != nil {
			return e
		}
		if e = d.Reconcile(ctx, false); e != nil {
			return e
		}
		d.State.Ready = true
		if e = d.persist(); e != nil {
			return e
		}
	}
	d.Error = ""
	return nil
}
func (d *Daemon) eligibleUpgrade() *model.Upgrade {
	u := d.Config.Desired.Upgrade
	if u != nil && u.Version != d.Version && d.Upgrade != nil && (d.State.UpgradeVersion != u.Version || d.Now().Sub(d.State.UpgradeAttempt) >= 5*time.Minute) {
		copy := *u
		return &copy
	}
	return nil
}
func (d *Daemon) prepareUpload() error {
	d.State.Prune(d.Now())
	// Keep each pending payload immutable until its acknowledgment is fsynced.
	// A process crash after Worker accepted it repeats the same sequence + body.
	if len(d.State.Pending) == 0 {
		status := "ready"
		message := ""
		if d.Error != "" {
			status = "error"
			message = d.Error
		}
		// Only expose the two non-secret, retryable sync errors in persisted payloads.
		if message != "control service unavailable" && message != "invalid control response" && message != "verified upgrade handoff failed" {
			message = ""
		}
		if e := d.State.Queue(d.Config.Desired.Revision, d.Version, status, message); e != nil {
			return e
		}
	}
	if e := d.persist(); e != nil {
		return e
	}
	return nil
}
func (d *Daemon) Upload(ctx context.Context) error {
	if e := d.prepareUpload(); e != nil {
		return e
	}
	count := len(d.State.Pending)
	for i := 0; i < count; i++ {
		if e := d.Control.Snapshot(ctx, d.State.Pending[0]); e != nil {
			if errors.Is(e, control.ErrAuth) {
				return e
			}
			d.Error = control.Safe(e)
			return nil
		}
		d.State.Pending = d.State.Pending[1:]
		if e := d.persist(); e != nil {
			return e
		}
	}
	d.Error = ""
	return nil
}
func (d *Daemon) wait(ctx context.Context) error {
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	for {
		c, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, e := d.API.Health(c)
		cancel()
		if e == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ErrLocal
		case <-deadline.C:
			return ErrLocal
		case <-time.After(time.Second):
		}
	}
}
func (d *Daemon) Run(ctx context.Context) error {
	return d.run(ctx, 10*time.Second, 60*time.Second, 300*time.Second)
}
func (d *Daemon) run(ctx context.Context, sampleEvery, pollEvery, uploadEvery time.Duration) (result error) {
	// Lock is acquired by CLI before loading files, preventing rotate/run races.
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// Always sample with a fresh context: SIGTERM's canceled context is unusable.
		if e := d.Sample(c, false); e != nil && result == nil {
			result = ErrLocal
		}
		d.State.Ready = false
		if e := d.persist(); e != nil && result == nil {
			result = e
		}
		_ = d.Notify("STOPPING=1")
		// Also stop explicitly (especially for HTTP 401/403); unit BindsTo is a
		// second fail-closed defense, not a replacement for this call.
		if e := d.StopXray(c); e != nil && result == nil {
			result = ErrLocal
		}
	}()
	if e := d.wait(ctx); e != nil {
		return e
	}
	if e := d.Sample(ctx, true); e != nil {
		return e
	}
	// Validate any available remote metadata before READY; unreachable control
	// stays offline with cached, validated quotas. Revocation is immediately fatal.
	if e := d.Poll(ctx); e != nil {
		return e
	}
	if e := d.Notify("READY=1"); e != nil {
		return e
	}
	if e := d.Notify("WATCHDOG=1"); e != nil {
		return e
	}
	// Network work runs outside the accounting loop. Only this goroutine mutates
	// durable state; slow/offline Cloudflare and release downloads cannot defer limits.
	workCtx, cancelWork := context.WithCancel(ctx)
	defer cancelWork()
	type configResult struct {
		value model.Desired
		err   error
	}
	type snapshotResult struct {
		sequence uint64
		err      error
	}
	type upgradeResult struct {
		version string
		err     error
	}
	configs := make(chan configResult, 1)
	snapshots := make(chan snapshotResult, 1)
	upgrades := make(chan upgradeResult, 1)
	polling, uploading, upgrading := false, false, false
	startPoll := func() {
		if polling {
			return
		}
		polling = true
		revision := d.Config.Desired.Revision
		go func() {
			value, e := d.Control.Config(workCtx, revision)
			select {
			case configs <- configResult{value, e}:
			case <-workCtx.Done():
			}
		}()
	}
	var startUpload func() error
	startUpload = func() error {
		if uploading {
			return nil
		}
		if e := d.prepareUpload(); e != nil {
			return e
		}
		if len(d.State.Pending) == 0 {
			return nil
		}
		p := d.State.Pending[0]
		uploading = true
		go func() {
			e := d.Control.Snapshot(workCtx, p)
			select {
			case snapshots <- snapshotResult{p.Sequence, e}:
			case <-workCtx.Done():
			}
		}()
		return nil
	}
	startUpgrade := func() error {
		if upgrading {
			return nil
		}
		u := d.eligibleUpgrade()
		if u == nil {
			return nil
		}
		d.State.UpgradeVersion = u.Version
		d.State.UpgradeAttempt = d.Now()
		if e := d.persist(); e != nil {
			return e
		}
		upgrading = true
		go func() {
			c, cancel := context.WithTimeout(workCtx, 35*time.Second)
			defer cancel()
			e := d.Upgrade.Apply(c, d.Root, d.Version, u)
			select {
			case upgrades <- upgradeResult{u.Version, e}:
			case <-workCtx.Done():
			}
		}()
		return nil
	}
	sample := time.NewTicker(sampleEvery)
	defer sample.Stop()
	poll := time.NewTicker(pollEvery)
	defer poll.Stop()
	upload := time.NewTicker(uploadEvery)
	defer upload.Stop()
	if e := startUpload(); e != nil {
		return e
	}
	if e := startUpgrade(); e != nil {
		return e
	}
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-sample.C:
			if e := d.Sample(ctx, false); e != nil {
				if !errors.Is(e, xray.ErrAPI) {
					return e
				}
				failures++
				if failures >= 3 {
					return ErrLocal
				}
			} else {
				failures = 0
				if e = d.Notify("WATCHDOG=1"); e != nil {
					return e
				}
			}
		case <-poll.C:
			startPoll()
		case r := <-configs:
			polling = false
			if e := d.acceptConfig(ctx, r.value, r.err); e != nil {
				return e
			}
			if e := startUpgrade(); e != nil {
				return e
			}
		case <-upload.C:
			if e := startUpload(); e != nil {
				return e
			}
		case r := <-snapshots:
			uploading = false
			if r.err != nil {
				if errors.Is(r.err, control.ErrAuth) {
					return r.err
				}
				d.Error = control.Safe(r.err)
				continue
			}
			// Month rollover may have pruned an ancient in-flight payload. Never remove
			// a different sequence in its place; acknowledgments are fsynced before reuse.
			for i, p := range d.State.Pending {
				if p.Sequence == r.sequence {
					d.State.Pending = append(d.State.Pending[:i], d.State.Pending[i+1:]...)
					break
				}
			}
			if e := d.persist(); e != nil {
				return e
			}
			d.Error = ""
			if len(d.State.Pending) > 0 {
				if e := startUpload(); e != nil {
					return e
				}
			}
		case r := <-upgrades:
			upgrading = false
			if r.err != nil {
				d.Error = "verified upgrade handoff failed"
			}
		}
	}
}
func Check(ctx context.Context, root, version string, api xray.API) error {
	d, e := Load(root, version, api)
	if e != nil {
		return e
	}
	if !d.State.Ready || d.Now().Sub(d.State.LastSample) > 30*time.Second || d.State.LastSample.After(d.Now().Add(time.Second)) {
		return ErrHealth
	}
	if _, e = api.Health(ctx); e != nil {
		return ErrHealth
	}
	users, e := api.Users(ctx)
	if e != nil {
		return ErrHealth
	}
	allowed := d.State.Allowed(d.Config.Desired)
	if len(users) != len(allowed) {
		return ErrHealth
	}
	for _, email := range users {
		if _, ok := allowed[email]; !ok {
			return ErrHealth
		}
	}
	return nil
}
func Rotate(ctx context.Context, root, version string) error {
	// Caller holds the same exclusive root lock as run. Operator must stop agent;
	// installer units must stop Xray at the same time (zero unmetered rotation).
	var c model.Installed
	path := filepath.Join(root, "config", "agent.json")
	if e := state.Load(path, &c); e != nil {
		return e
	}
	if e := c.Validate(); e != nil {
		return e
	}
	client, e := control.New(c.ControlURL, c.Credential)
	if e != nil {
		return e
	}
	credential, e := client.Rotate(ctx)
	if e != nil {
		return e
	}
	c.Credential = credential
	if e = state.Save(path, c); e != nil {
		return e
	}
	return nil
}

// Existing returns false only for ENOENT, never for permission/corruption errors.
func Existing(path string) bool { _, e := os.Lstat(path); return !errors.Is(e, os.ErrNotExist) }
