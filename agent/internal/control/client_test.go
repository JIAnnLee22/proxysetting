package control

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"proxysetting/agent/internal/model"
	"strings"
	"testing"
)

func TestHTTPContractAndErrors(t *testing.T) {
	for _, code := range []int{200, 401, 403, 429, 500, 400} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer secret" || r.URL.Path != "/api/agent/config" || r.URL.Query().Get("revision") != "3" {
					t.Error("wrong request")
				}
				w.WriteHeader(code)
				if code == 200 {
					_ = json.NewEncoder(w).Encode(model.Desired{Schema: 1, Users: []model.User{}})
				} else {
					_, _ = w.Write([]byte("secret UUID credential token privateKey"))
				}
			}))
			defer s.Close()
			c, e := New(s.URL, "secret")
			if e != nil {
				t.Fatal(e)
			}
			c.HTTP = s.Client()
			_, e = c.Config(context.Background(), 3)
			switch code {
			case 200:
				if e != nil {
					t.Fatal(e)
				}
			case 401, 403:
				if !errors.Is(e, ErrAuth) {
					t.Fatal(e)
				}
			case 429, 500:
				if !errors.Is(e, ErrNetwork) {
					t.Fatal(e)
				}
			default:
				if !errors.Is(e, ErrRejected) {
					t.Fatal(e)
				}
			}
			if e != nil && strings.Contains(e.Error(), "secret") {
				t.Fatal("secret leaked")
			}
		})
	}
}
func TestResponseBoundAndJSON(t *testing.T) {
	for _, body := range []string{strings.Repeat("x", MaxBody+1), "{} {}", "{\"unknown\":1}"} {
		s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		c, _ := New(s.URL, "")
		c.HTTP = s.Client()
		if _, e := c.Config(context.Background(), 1); e != ErrProtocol {
			t.Fatal(e)
		}
		s.Close()
	}
}
func TestEnrollmentNeverRetriesAndNoAuth(t *testing.T) {
	calls := 0
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "" {
			t.Fatal("enrollment used auth")
		}
		w.WriteHeader(500)
	}))
	defer s.Close()
	c, _ := New(s.URL, "")
	c.HTTP = s.Client()
	_, _ = c.Enroll(context.Background(), Register{Token: "secret"})
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestNoCredentialRedirect(t *testing.T) {
	calls := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer target.Close()
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer s.Close()
	c, _ := New(s.URL, "secret")
	c.HTTP.Transport = s.Client().Transport
	if _, e := c.Config(context.Background(), 1); e != ErrRejected || calls != 0 {
		t.Fatal("redirect forwarded credential")
	}
}
