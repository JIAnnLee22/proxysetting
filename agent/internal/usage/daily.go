package usage

import (
	"errors"
	"sort"
	"time"

	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/xray"
)

var ErrArchive = errors.New("invalid archive state")

type DailyEntry struct {
	Uplink   uint64 `json:"uplink"`
	Downlink uint64 `json:"downlink"`
}

type DailyState struct {
	Date      string                `json:"date"`
	Users     map[string]DailyEntry `json:"users"`
	Quality   string                `json:"quality"`
	Archives  []model.Archive       `json:"archives"`
	SeqOffset uint64                `json:"seqOffset"`
}

func NewDaily(now time.Time) *DailyState {
	_, d := model.Calendar(now)
	return &DailyState{Date: d, Users: map[string]DailyEntry{}, Quality: "partial"}
}

func (s *DailyState) Validate() error {
	t, e := time.ParseInLocation("2006-01-02", s.Date, model.Beijing)
	if e != nil || s.Date == "" {
		return ErrState
	}
	for id, u := range s.Users {
		if !model.ValidID(id) || u.Uplink > model.MaxSafe || u.Downlink > model.MaxSafe || u.Uplink > model.MaxSafe-u.Downlink {
			return ErrState
		}
	}
	for _, a := range s.Archives {
		if a.Type != "daily" && a.Type != "month" {
			return ErrArchive
		}
		if a.Quality != "complete" && a.Quality != "partial" && a.Quality != "missing" {
			return ErrArchive
		}
	}
	return nil
}

func (s *DailyState) Add(now time.Time, deltas map[string]xray.Counter, reset bool) {
	_, day := model.Calendar(now)
	if day != s.Date {
		// rollover
		s.ArchiveCurrent()
		s.Date = day
		s.Users = map[string]DailyEntry{}
		s.Quality = "complete" // Start new day clean
	}
	if reset && s.Quality == "complete" {
		s.Quality = "partial"
	}
	for id, d := range deltas {
		if !model.ValidID(id) {
			continue
		}
		u := s.Users[id]
		u.Uplink += d.Up
		u.Downlink += d.Down
		s.Users[id] = u
	}
}

func (s *DailyState) ArchiveCurrent() {
	if s.Date == "" {
		return
	}
	arch := model.Archive{
		Period:  s.Date,
		Type:    "daily",
		Quality: s.Quality,
		Users:   []model.DailyUser{},
	}
	ids := make([]string, 0, len(s.Users))
	for id := range s.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v := s.Users[id]
		arch.Users = append(arch.Users, model.DailyUser{ID: id, Uplink: v.Uplink, Downlink: v.Downlink})
	}
	s.Archives = append(s.Archives, arch)
}

func (s *DailyState) CurrentDaily() *model.Daily {
	d := &model.Daily{
		Date:     s.Date,
		Quality:  s.Quality,
		Archived: false,
		Users:    []model.DailyUser{},
	}
	ids := make([]string, 0, len(s.Users))
	for id := range s.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v := s.Users[id]
		d.Users = append(d.Users, model.DailyUser{ID: id, Uplink: v.Uplink, Downlink: v.Downlink})
	}
	return d
}

func (s *DailyState) PeekArchive() *model.Archive {
	if len(s.Archives) > 0 {
		return &s.Archives[0]
	}
	return nil
}

func (s *DailyState) PopArchive() {
	if len(s.Archives) > 0 {
		s.Archives = s.Archives[1:]
	}
}

func (s *DailyState) Prune(now time.Time) {
	t := now.In(model.Beijing)
	minimumDate := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, model.Beijing).AddDate(0, 0, -400).Format("2006-01-02")
	minimumMonth := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, model.Beijing).AddDate(0, -60, 0).Format("2006-01")
	kept := make([]model.Archive, 0, len(s.Archives))
	for _, a := range s.Archives {
		if a.Type == "daily" && a.Period >= minimumDate {
			kept = append(kept, a)
		} else if a.Type == "month" && a.Period >= minimumMonth {
			kept = append(kept, a)
		}
	}
	s.Archives = kept
}

