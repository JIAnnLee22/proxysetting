package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"proxysetting/agent/internal/control"
	"proxysetting/agent/internal/daemon"
	"proxysetting/agent/internal/install"
	"proxysetting/agent/internal/model"
	"proxysetting/agent/internal/notify"
	"proxysetting/agent/internal/state"
	"proxysetting/agent/internal/upgrade"
	"proxysetting/agent/internal/usage"
	"proxysetting/agent/internal/xray"
)

// Set by release CI: -ldflags="-X main.version=vX.Y.Z".
var version = "v0.1.1"
var errCLI = errors.New("usage: proxysetting-agent install|run|check|rotate --root ROOT")

func execute(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		fmt.Fprintln(out, version)
		return nil
	}
	if len(args) == 0 {
		return errCLI
	}
	command := args[0]
	if command != "install" && command != "run" && command != "check" && command != "rotate" {
		return errCLI
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // flags may contain a one-use token
	root := fs.String("root", "/opt/proxysetting", "installation root")
	var url, token, address, name *string
	var port *int
	if command == "install" {
		url = fs.String("control-url", "", "HTTPS control origin")
		token = fs.String("token", "", "one-use token; prefer PROXYSETTING_ENROLL_TOKEN")
		address = fs.String("address", "", "public IP")
		port = fs.Int("port", 443, "public port")
		name = fs.String("server-name", "", "verified TLS 1.3 Reality target")
	}
	if e := fs.Parse(args[1:]); e != nil || fs.NArg() != 0 {
		return errCLI
	}
	r, e := state.Root(*root)
	if e != nil {
		return e
	}
	if command == "install" {
		t := *token
		if t == "" {
			t = os.Getenv("PROXYSETTING_ENROLL_TOKEN")
		}
		os.Unsetenv("PROXYSETTING_ENROLL_TOKEN") // never forward the token to xray/systemd subprocesses
		ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if e = install.Install(ctx, install.Options{Root: r, ControlURL: *url, Token: t, Address: *address, Port: *port, ServerName: *name, Version: version}, install.Hooks{}); e != nil {
			return e
		}
		fmt.Fprintln(out, "installed; configuration and billing state saved; start systemd services")
		return nil
	}
	var lock *os.File
	if command == "run" || command == "rotate" {
		lock, e = state.Lock(r)
		if e != nil {
			return e
		}
		defer lock.Close()
	}
	if command == "rotate" {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if e = daemon.Rotate(ctx, r, version); e != nil {
			return e
		}
		fmt.Fprintln(out, "device credential rotated and saved; restart agent services")
		return nil
	}
	api, e := xray.New()
	if e != nil {
		return e
	}
	defer api.Close()
	if command == "check" {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if e = daemon.Check(ctx, r, version, api); e != nil {
			return e
		}
		fmt.Fprintln(out, "ready; local Xray API and durable billing state healthy")
		return nil
	}
	d, e := daemon.Load(r, version, api)
	if e != nil {
		// Corrupt/missing files must not leave an independently started Xray running.
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = execStop(c)
		return e
	}
	return d.Run(ctx)
}
func execStop(ctx context.Context) error {
	if e := exec.CommandContext(ctx, "systemctl", "stop", "--no-block", "proxysetting-xray.service").Run(); e != nil {
		return daemon.ErrLocal
	}
	return nil
}
func safeError(err error) string {
	for _, e := range []error{errCLI, model.ErrConfig, state.ErrIO, state.ErrLocked, install.ErrInstall, install.ErrTLS, install.ErrPort, control.ErrAuth, control.ErrNetwork, control.ErrProtocol, control.ErrRejected, daemon.ErrLocal, daemon.ErrHealth, usage.ErrState, usage.ErrClock, xray.ErrAPI, notify.ErrNotify, upgrade.ErrUpgrade} {
		if errors.Is(err, e) {
			return e.Error()
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		return "required local file missing"
	}
	return "agent operation failed"
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if e := execute(ctx, os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, "proxysetting-agent: "+safeError(e))
		os.Exit(1)
	}
}
