// Package usage computes monotonic monthly totals from non-resetting Xray counters.
package usage

import (
	"errors"
	"sort"
	"time"

	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/xray"
)

var ErrState = errors.New("invalid usage state")
var ErrClock = errors.New("local clock moved to an earlier billing month")

type Entry struct {
	Uplink   uint64 `json:"uplink"`
	Downlink uint64 `json:"downlink"`
	RawUp    uint64 `json:"rawUp"`
	RawDown  uint64 `json:"rawDown"`
	Disabled bool   `json:"disabled"`
}
type State struct {
	Schema         int              `json:"schema"`
	Month          string           `json:"month"`
	Day            string           `json:"day"`
	LastSample     time.Time        `json:"lastSample"`
	XrayStart      int64            `json:"xrayStart"`
	Ready          bool             `json:"ready"`
	Sequence       uint64           `json:"sequence"`
	Users          map[string]Entry `json:"users"`
	Pending        []model.Snapshot `json:"pending"`
	UpgradeVersion string           `json:"upgradeVersion"`
	UpgradeAttempt time.Time        `json:"upgradeAttempt"`
}

func New(now time.Time) *State {
	m, d := model.Calendar(now)
	return &State{Schema: model.Schema, Month: m, Day: d, Users: map[string]Entry{}, Pending: []model.Snapshot{}}
}
func (s *State) Validate() error {
	t, e := time.ParseInLocation("2006-01-02", s.Day, model.Beijing)
	if e != nil || t.Format("2006-01") != s.Month || s.Schema != model.Schema || s.Sequence > model.MaxSafe || s.Users == nil || len(s.Users) > 50 || len(s.Pending) > 3 {
		return ErrState
	}
	for id, u := range s.Users {
		if !model.ValidID(id) || u.Uplink > model.MaxSafe || u.Downlink > model.MaxSafe || u.Uplink > model.MaxSafe-u.Downlink || u.RawUp > model.MaxSafe || u.RawDown > model.MaxSafe {
			return ErrState
		}
	}
	var prev uint64
	for _, p := range s.Pending {
		if p.Schema != model.Schema || p.Sequence == 0 || p.Sequence > s.Sequence || p.Sequence <= prev || p.Status != "ready" && p.Status != "error" || len(p.Error) > 256 || len(p.Users) > 50 || !model.ValidVersion(p.Version) || p.Revision > model.MaxSafe {
			return ErrState
		}
		// Persisted payloads must not be used as a vehicle for arbitrary error/secret strings.
		if p.Error != "" && p.Error != "control service unavailable" && p.Error != "invalid control response" && p.Error != "verified upgrade handoff failed" {
			return ErrState
		}
		t, e := time.ParseInLocation("2006-01-02", p.Day, model.Beijing)
		if e != nil || t.Format("2006-01") != p.Month {
			return ErrState
		}
		ids := map[string]bool{}
		for _, u := range p.Users {
			if !model.ValidID(u.ID) || ids[u.ID] || u.Uplink > model.MaxSafe || u.Downlink > model.MaxSafe || u.Uplink > model.MaxSafe-u.Downlink {
				return ErrState
			}
			ids[u.ID] = true
		}
		prev = p.Sequence
	}
	return nil
}
func (s *State) Ensure(d model.Desired) error {
	if e := d.Validate(); e != nil {
		return e
	}
	count := len(s.Users)
	for _, u := range d.Users {
		if _, ok := s.Users[u.ID]; !ok {
			count++
		}
	}
	if count > 50 {
		return ErrState
	} // Never silently omit historical users from a monthly snapshot.
	for _, u := range d.Users {
		if _, ok := s.Users[u.ID]; !ok {
			s.Users[u.ID] = Entry{Disabled: true}
		}
	}
	s.Disable(d)
	return nil
}

// Merge treats Worker monthly snapshots as cumulative, never additive. Raw Xray
// baselines remain local. Remote disabled is informational; the current explicit
// quota determines authorization (a later quota increase can legitimately restore).
func (s *State) Merge(now time.Time, d model.Desired) error {
	if e := d.Validate(); e != nil {
		return e
	}
	month, _ := model.Calendar(now)
	if d.Usage == nil || d.Usage.Month != month || s.Month != month {
		return nil
	}
	count := len(s.Users)
	for _, u := range d.Usage.Users {
		if _, ok := s.Users[u.ID]; !ok {
			count++
		}
	}
	if count > 50 {
		return ErrState
	}
	for _, u := range d.Usage.Users {
		v := s.Users[u.ID]
		v.Uplink = max(v.Uplink, u.Uplink)
		v.Downlink = max(v.Downlink, u.Downlink)
		if v.Uplink > model.MaxSafe-v.Downlink {
			return ErrState
		}
		s.Users[u.ID] = v
	}
	s.Disable(d)
	return nil
}
func (s *State) Disable(d model.Desired) {
	quotas := map[string]uint64{}
	for _, u := range d.Users {
		quotas[u.ID] = u.QuotaBytes
	}
	for id, v := range s.Users {
		q, ok := quotas[id]
		v.Disabled = !ok || q == 0 || v.Uplink+v.Downlink >= q
		s.Users[id] = v
	}
}
func delta(value, old uint64, reset bool) uint64 {
	if reset || value < old {
		return value
	}
	return value - old
}
func (s *State) Sample(now time.Time, counters map[string]xray.Counter, reset bool, d model.Desired, version string) error {
	month, day := model.Calendar(now)
	if month < s.Month {
		return ErrClock
	}
	if e := s.Ensure(d); e != nil {
		return e
	}
	rollover := month != s.Month
	if rollover {
		// The interval straddling midnight cannot be split from aggregate counters.
		// Do NOT charge pre-midnight bytes to the new month: checkpoint last known old
		// totals, then rebase both directions. At most one sampling interval is unbilled.
		s.Prune(now)
		if e := s.Queue(d.Revision, version, "ready", ""); e != nil {
			return e
		}
		for id, v := range s.Users {
			v.Uplink = 0
			v.Downlink = 0
			s.Users[id] = v
		}
		s.Month = month
	}
	for id, v := range s.Users {
		c, ok := counters[id+"@proxysetting"]
		if !ok { // Counter temporarily absent: keep the baseline unless Xray restarted.
			if reset {
				v.RawUp = 0
				v.RawDown = 0
				s.Users[id] = v
			}
			continue
		}
		if c.Up > model.MaxSafe || c.Down > model.MaxSafe {
			return ErrState
		}
		if !rollover {
			up, down := delta(c.Up, v.RawUp, reset), delta(c.Down, v.RawDown, reset)
			if up > model.MaxSafe-v.Uplink || down > model.MaxSafe-v.Downlink {
				return ErrState
			}
			v.Uplink += up
			v.Downlink += down
			if v.Uplink > model.MaxSafe-v.Downlink {
				return ErrState
			}
		}
		v.RawUp = c.Up
		v.RawDown = c.Down
		s.Users[id] = v
	}
	s.Day = day
	s.LastSample = now.UTC()
	s.Disable(d)
	return s.Merge(now, d)
}
func (s *State) Allowed(d model.Desired) map[string]model.User {
	out := map[string]model.User{}
	for _, u := range d.Users {
		v, ok := s.Users[u.ID]
		if ok && !v.Disabled && u.QuotaBytes > 0 && v.Uplink+v.Downlink < u.QuotaBytes {
			out[u.Email] = u
		}
	}
	return out
}
func (s *State) Queue(revision uint64, version, status, message string) error {
	if s.Sequence >= model.MaxSafe || len(s.Pending) >= 3 || !model.ValidVersion(version) {
		return ErrState
	}
	s.Sequence++
	p := model.Snapshot{Schema: model.Schema, Sequence: s.Sequence, Month: s.Month, Day: s.Day, Revision: revision, Version: version, Status: status, Error: message, Users: []model.SnapshotUser{}}
	ids := make([]string, 0, len(s.Users))
	for id := range s.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v := s.Users[id]
		p.Users = append(p.Users, model.SnapshotUser{ID: id, Uplink: v.Uplink, Downlink: v.Downlink, Disabled: v.Disabled})
	}
	s.Pending = append(s.Pending, p)
	return nil
}
func (s *State) Prune(now time.Time) {
	// Worker accepts current and previous month only. An immutable pending payload
	// is NEVER edited/reused with the same sequence, including across restarts.
	t := now.In(model.Beijing)
	minimum := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, model.Beijing).AddDate(0, -1, 0).Format("2006-01")
	kept := make([]model.Snapshot, 0, len(s.Pending))
	for _, p := range s.Pending {
		if p.Month >= minimum {
			kept = append(kept, p)
		}
	}
	s.Pending = kept
}
