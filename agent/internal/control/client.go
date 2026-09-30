// Package control implements bounded HTTPS Worker requests. Remote bodies and
// underlying HTTP errors are never included in error messages (they may contain secrets).
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"proxysetting/agent/internal/model"
)

var (
	ErrAuth     = errors.New("device authorization revoked")
	ErrNetwork  = errors.New("control service unavailable")
	ErrProtocol = errors.New("invalid control response")
	ErrRejected = errors.New("control request rejected")
)

const MaxBody = 64 << 10

type Register struct {
	Token      string `json:"token"`
	Address    string `json:"address"`
	Port       int    `json:"port"`
	PublicKey  string `json:"publicKey"`
	ShortID    string `json:"shortId"`
	ServerName string `json:"serverName"`
	Version    string `json:"version"`
}
type Enrollment struct {
	VPSID      string        `json:"vpsId"`
	Credential string        `json:"credential"`
	Config     model.Desired `json:"config"`
}
type Client struct {
	Base       string
	Credential string
	HTTP       *http.Client
}

func New(base, credential string) (*Client, error) {
	if model.ControlURL(base) != nil {
		return nil, model.ErrConfig
	}
	return &Client{Base: strings.TrimRight(base, "/"), Credential: credential, HTTP: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) request(ctx context.Context, method, path string, body, out any) error {
	var data []byte
	if body != nil {
		var e error
		data, e = json.Marshal(body)
		if e != nil || len(data) > MaxBody {
			return ErrProtocol
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, c.Base+path, bytes.NewReader(data))
	if e != nil {
		return ErrProtocol
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+c.Credential)
	}
	resp, e := c.HTTP.Do(req)
	if e != nil {
		return ErrNetwork
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return ErrAuth
	}
	if resp.StatusCode >= 500 || resp.StatusCode == 429 {
		return ErrNetwork
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrRejected
	}
	data, e = io.ReadAll(io.LimitReader(resp.Body, MaxBody+1))
	if e != nil || len(data) > MaxBody {
		return ErrProtocol
	}
	if out != nil {
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		if e = dec.Decode(out); e != nil {
			return ErrProtocol
		}
		if e = dec.Decode(new(any)); e != io.EOF {
			return ErrProtocol
		}
	}
	return nil
}

// Enroll makes exactly one request: a lost one-use token response cannot be retried.
func (c *Client) Enroll(ctx context.Context, in Register) (Enrollment, error) {
	var out Enrollment
	e := c.request(ctx, http.MethodPost, "/api/agent/register", in, &out)
	return out, e
}
func (c *Client) Config(ctx context.Context, revision uint64) (model.Desired, error) {
	var out model.Desired
	e := c.request(ctx, http.MethodGet, "/api/agent/config?revision="+strconv.FormatUint(revision, 10), nil, &out)
	return out, e
}
func (c *Client) Snapshot(ctx context.Context, s model.Snapshot) error {
	return c.request(ctx, http.MethodPost, "/api/agent/snapshot", s, nil)
}
func (c *Client) Seed(ctx context.Context) (*model.Daily, error) {
	var out model.Daily
	if e := c.request(ctx, http.MethodGet, "/api/agent/analytics/seed", nil, &out); e != nil {
		return nil, e
	}
	return &out, nil
}
func (c *Client) Rotate(ctx context.Context) (string, error) {
	var out struct {
		Credential string `json:"credential"`
	}
	if e := c.request(ctx, http.MethodPost, "/api/agent/rotate", struct{}{}, &out); e != nil {
		return "", e
	}
	if !model.ValidSecret(out.Credential) {
		return "", ErrProtocol
	}
	return out.Credential, nil
}

// Safe returns a whitelist message suitable for logs/snapshots, never err.Error().
func Safe(e error) string {
	for _, v := range []error{ErrAuth, ErrNetwork, ErrProtocol, ErrRejected, model.ErrConfig} {
		if errors.Is(e, v) {
			return v.Error()
		}
	}
	return fmt.Sprint("agent operation failed")
}
