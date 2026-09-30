// Package model defines the Worker v1 wire contract and validates untrusted configuration.
package model

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	Schema      = 1
	MaxSafe     = uint64(1<<53 - 1)
	GiB         = uint64(1 << 30)
	MaxQuota    = 102400 * GiB
	XrayVersion = "26.3.27"
	APIAddress  = "127.0.0.1:10085"
	InboundTag  = "vless-reality"
)

var (
	idRE      = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	uuidRE    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	versionRE = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$`)
	dnsRE     = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
)

// Errors deliberately never interpolate wire data, paths, credentials or UUIDs.
var ErrConfig = errors.New("invalid configuration")

type User struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	UUID       string `json:"uuid"`
	QuotaBytes uint64 `json:"quotaBytes"`
}
type Upgrade struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}
type RemoteUsage struct {
	Month string         `json:"month"`
	Users []SnapshotUser `json:"users"`
}
type Desired struct {
	Schema     int          `json:"schema"`
	VPSID      string       `json:"vpsId"`
	Revision   uint64       `json:"revision"`
	Port       int          `json:"port"`
	ServerName string       `json:"serverName"`
	Users      []User       `json:"users"`
	Upgrade    *Upgrade     `json:"upgrade"`
	Usage      *RemoteUsage `json:"usage,omitempty"`
}
type Installed struct {
	Schema     int     `json:"schema"`
	ControlURL string  `json:"controlUrl"`
	Address    string  `json:"address"`
	Port       int     `json:"port"`
	ServerName string  `json:"serverName"`
	PublicKey  string  `json:"publicKey"`
	PrivateKey string  `json:"privateKey"`
	ShortID    string  `json:"shortId"`
	VPSID      string  `json:"vpsId"`
	Credential string  `json:"credential"`
	Desired    Desired `json:"desired"`
}
type SnapshotUser struct {
	ID       string `json:"id"`
	Uplink   uint64 `json:"uplink"`
	Downlink uint64 `json:"downlink"`
	Disabled bool   `json:"disabled"`
}
type Snapshot struct {
	Schema   int            `json:"schema"`
	Sequence uint64         `json:"sequence"`
	Month    string         `json:"month"`
	Day      string         `json:"day"`
	Revision uint64         `json:"revision"`
	Version  string         `json:"version"`
	Status   string         `json:"status"`
	Error    string         `json:"error"`
	Users    []SnapshotUser `json:"users"`
}

// Fixed UTC+8 avoids dependence on a host's zoneinfo or TZ setting.
var Beijing = time.FixedZone("Asia/Shanghai", 8*60*60)

func Calendar(t time.Time) (string, string) {
	t = t.In(Beijing)
	return t.Format("2006-01"), t.Format("2006-01-02")
}
func PublicIP(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback()
}
func ValidID(s string) bool      { return idRE.MatchString(s) }
func ValidVersion(s string) bool { return len(s) <= 80 && versionRE.MatchString(s) }
func ValidDNS(s string) bool {
	if len(s) > 253 || !strings.Contains(s, ".") || net.ParseIP(s) != nil {
		return false
	}
	for _, p := range strings.Split(s, ".") {
		if !dnsRE.MatchString(p) {
			return false
		}
	}
	return true
}
func ValidSecret(s string) bool {
	if len(s) == 64 {
		_, e := hex.DecodeString(s)
		return e == nil
	}
	b, e := base64.RawURLEncoding.DecodeString(s)
	return e == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == s
}
func ControlURL(s string) error {
	u, e := url.Parse(s)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return ErrConfig
	}
	return nil
}
func ValidateUpgrade(u *Upgrade) error {
	if u == nil {
		return nil
	}
	if !ValidVersion(u.Version) || len(u.SHA256) != 64 {
		return ErrConfig
	}
	if _, e := hex.DecodeString(u.SHA256); e != nil {
		return ErrConfig
	}
	p, e := url.Parse(u.URL)
	if e != nil || p.Scheme != "https" || p.Host != "github.com" || p.User != nil || p.RawQuery != "" || p.Fragment != "" || p.RawPath != "" {
		return ErrConfig
	}
	parts := strings.Split(strings.TrimPrefix(p.Path, "/"), "/")
	if len(parts) != 6 || !ValidID(parts[0]) || !regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$`).MatchString(parts[1]) || parts[2] != "releases" || parts[3] != "download" || parts[4] != u.Version || parts[5] != "install.sh" {
		return ErrConfig
	}
	return nil
}
func (d Desired) Validate() error {
	if d.Schema != Schema || !ValidID(d.VPSID) || d.Revision == 0 || d.Revision > MaxSafe || d.Port < 1 || d.Port > 65535 || d.Port == 10085 || !ValidDNS(d.ServerName) || d.Users == nil || len(d.Users) > 50 {
		return ErrConfig
	}
	ids, uuids := map[string]bool{}, map[string]bool{}
	for _, u := range d.Users {
		if !ValidID(u.ID) || u.Email != u.ID+"@proxysetting" || !uuidRE.MatchString(u.UUID) || u.QuotaBytes == 0 || u.QuotaBytes > MaxQuota || ids[u.ID] || uuids[strings.ToLower(u.UUID)] {
			return ErrConfig
		}
		ids[u.ID] = true
		uuids[strings.ToLower(u.UUID)] = true
	}
	if d.Usage != nil {
		t, e := time.ParseInLocation("2006-01", d.Usage.Month, Beijing)
		if e != nil || t.Format("2006-01") != d.Usage.Month || d.Usage.Users == nil || len(d.Usage.Users) > 50 {
			return ErrConfig
		}
		used := map[string]bool{}
		for _, u := range d.Usage.Users {
			if !ValidID(u.ID) || used[u.ID] || u.Uplink > MaxSafe || u.Downlink > MaxSafe || u.Uplink > MaxSafe-u.Downlink {
				return ErrConfig
			}
			used[u.ID] = true
		}
	}
	return ValidateUpgrade(d.Upgrade)
}
func (d Desired) Matches(c Installed) error {
	if e := d.Validate(); e != nil {
		return e
	}
	if d.VPSID != c.VPSID || d.Port != c.Port || d.ServerName != c.ServerName || d.Revision < c.Desired.Revision {
		return ErrConfig
	}
	return nil
}
func (c Installed) Validate() error {
	if c.Schema != Schema || ControlURL(c.ControlURL) != nil || !PublicIP(c.Address) || !ValidSecret(c.Credential) {
		return ErrConfig
	}
	b, e := base64.RawURLEncoding.DecodeString(c.PrivateKey)
	if e != nil {
		return ErrConfig
	}
	k, e := ecdh.X25519().NewPrivateKey(b)
	if e != nil || base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()) != c.PublicKey {
		return ErrConfig
	}
	short, e := hex.DecodeString(c.ShortID)
	if e != nil || len(short) != 8 {
		return ErrConfig
	}
	return c.Desired.Matches(c)
}
