// Package service supervises an agent/Xray pair on Linux without root or systemd.
// Children die with the supervisor; only successful accounting feeds its watchdog.
package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"proxysetting/agent/internal/state"
)

var ErrService = errors.New("standalone service unavailable; inspect local service status")

func DefaultRoot() string {
	if os.Geteuid() == 0 {
		return "/opt/proxysetting"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "proxysetting")
}

// Missing mode preserves compatibility with installed systemd releases.
func Mode(root string) (string, error) {
	path := filepath.Join(root, "config", "release.env")
	st, e := os.Lstat(path)
	if errors.Is(e, os.ErrNotExist) {
		return "systemd", nil
	}
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1024 {
		return "", ErrService
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return "", ErrService
	}
	mode := "systemd"
	seen := false
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "SERVICE_MODE=") {
			if seen {
				return "", ErrService
			}
			seen = true
			mode = strings.TrimPrefix(line, "SERVICE_MODE=")
		}
	}
	if mode != "systemd" && mode != "standalone" {
		return "", ErrService
	}
	return mode, nil
}

func lock(root, name string) (*os.File, error) {
	path := filepath.Join(root, "state", name)
	fd, e := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return nil, ErrService
	}
	f := os.NewFile(uintptr(fd), path)
	if e = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, state.ErrLocked
	}
	return f, nil
}

type process struct {
	PID   int    `json:"pid"`
	Start string `json:"start"`
	Ready bool   `json:"ready"`
}

func recordPath(root string) string { return filepath.Join(root, "state", "supervisor.json") }
func identity(pid int) (string, error) {
	if pid <= 1 {
		return "", ErrService
	}
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return "", e
	}
	// comm can contain spaces and parentheses; fields after the final ')' start at 3.
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return "", ErrService
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) < 20 || fields[0] == "Z" {
		return "", os.ErrNotExist
	}
	return fields[19], nil // Linux /proc stat field 22: starttime.
}
func alive(p process) bool {
	start, e := identity(p.PID)
	return e == nil && start == p.Start
}
func readProcess(root string) (process, error) {
	var p process
	e := state.Load(recordPath(root), &p)
	if e != nil {
		return p, e
	}
	if p.PID <= 1 || p.Start == "" {
		return p, ErrService
	}
	return p, nil
}
func signal(p process, sig syscall.Signal) error {
	// pidfd prevents signalling an unrelated process after PID reuse on modern kernels.
	fd, e := unix.PidfdOpen(p.PID, 0)
	if e == nil {
		defer unix.Close(fd)
		if !alive(p) {
			return nil
		}
		return unix.PidfdSendSignal(fd, sig, nil, 0)
	}
	if !alive(p) {
		return nil
	}
	return syscall.Kill(p.PID, sig)
}

func Status(root string) error {
	p, e := readProcess(root)
	if e != nil || !alive(p) || !p.Ready {
		return ErrService
	}
	return nil
}
func Stop(root string) error {
	control, e := lock(root, "service-control.lock")
	if e != nil {
		return e
	}
	defer control.Close()
	return stop(root)
}
func stop(root string) error {
	p, e := readProcess(root)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return ErrService
	}
	if e = signal(p, syscall.SIGTERM); e != nil {
		return ErrService
	}
	deadline := time.Now().Add(50 * time.Second)
	for alive(p) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if alive(p) {
		if e = signal(p, syscall.SIGKILL); e != nil {
			return ErrService
		}
		for i := 0; i < 50 && alive(p); i++ {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if alive(p) {
		return ErrService
	}
	return nil
}

func Start(root string) error {
	control, e := lock(root, "service-control.lock")
	if e != nil {
		return e
	}
	defer control.Close()
	if p, e := readProcess(root); e == nil && alive(p) {
		return Status(root)
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return ErrService
	}
	bin, e := os.Executable()
	if e != nil {
		return ErrService
	}
	c := exec.Command(bin, "supervise", "--root", root)
	c.Env = cleanEnv()
	c.Dir = root
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	c.Stdout, c.Stderr = io.Discard, io.Discard
	if e = c.Start(); e != nil {
		return ErrService
	}
	pid := c.Process.Pid
	start, e := identity(pid)
	if e != nil {
		_ = c.Process.Kill()
		_ = c.Wait()
		return ErrService
	}
	go func() { _ = c.Wait() }()
	child := process{PID: pid, Start: start}
	deadline := time.Now().Add(95 * time.Second)
	for alive(child) && time.Now().Before(deadline) {
		p, e := readProcess(root)
		if e == nil && p.PID == pid && p.Start == start && p.Ready {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = signal(child, syscall.SIGTERM)
	_ = stop(root)
	return ErrService
}

func cleanEnv() []string {
	out := []string{}
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "NOTIFY_SOCKET=") && !strings.HasPrefix(v, "WATCHDOG_") && !strings.HasPrefix(v, "PROXYSETTING_ENROLL_TOKEN=") {
			out = append(out, v)
		}
	}
	return out
}

type child struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func spawn(bin string, args []string, env []string, root string) (*child, error) {
	c := exec.Command(bin, args...)
	c.Dir, c.Env = root, env
	c.Stdout, c.Stderr = io.Discard, io.Discard // Never log config/private keys.
	c.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if e := c.Start(); e != nil {
		return nil, ErrService
	}
	p := &child{cmd: c, done: make(chan struct{})}
	go func() { _ = c.Wait(); close(p.done) }()
	return p, nil
}
func (p *child) stop(timeout time.Duration) {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(timeout):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

// Supervise runs in its own session and holds a separate lock from run/rotate.
// It intentionally stays stopped on failure: no restart loop can mask revoked
// credentials or repeatedly restore grants after an accounting failure.
func Supervise(ctx context.Context, root string) error {
	// Linux parent-death signals track the creating thread, not just its process.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	mode, e := Mode(root)
	if e != nil || mode != "standalone" {
		return ErrService
	}
	guard, e := lock(root, "supervisor.lock")
	if e != nil {
		return e
	}
	defer guard.Close()
	start, e := identity(os.Getpid())
	if e != nil {
		return ErrService
	}
	p := process{PID: os.Getpid(), Start: start}
	if e = state.Save(recordPath(root), p); e != nil {
		return e
	}
	defer os.Remove(recordPath(root))
	tmp, e := os.MkdirTemp("", "proxysetting-notify-")
	if e != nil {
		return ErrService
	}
	defer os.RemoveAll(tmp)
	socket := filepath.Join(tmp, "notify.sock")
	conn, e := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: socket, Net: "unixgram"})
	if e != nil {
		return ErrService
	}
	defer conn.Close()
	if e = os.Chmod(socket, 0600); e != nil {
		return ErrService
	}
	env := cleanEnv()
	x, e := spawn(filepath.Join(root, "current", "bin", "xray"), []string{"run", "-config", filepath.Join(root, "config", "xray.json")}, env, root)
	if e != nil {
		return e
	}
	defer x.stop(15 * time.Second)
	bin, e := os.Executable()
	if e != nil {
		return ErrService
	}
	a, e := spawn(bin, []string{"run", "--supervised", "--root", root}, append(env, "NOTIFY_SOCKET="+socket), root)
	if e != nil {
		return e
	}
	// Agent exits/final-samples first while Xray is still alive.
	defer a.stop(30 * time.Second)
	messages := make(chan string, 16)
	go func() {
		b := make([]byte, 1024)
		for {
			n, _, e := conn.ReadFromUnix(b)
			if e != nil {
				return
			}
			select {
			case messages <- string(b[:n]):
			case <-ctx.Done():
				return
			}
		}
	}()
	deadline := time.Now().Add(90 * time.Second)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-a.done:
			_ = x.cmd.Process.Kill() // Never leave a grant-serving Xray after agent exit.
			return ErrService
		case <-x.done:
			return ErrService
		case message := <-messages:
			for _, line := range strings.Split(message, "\n") {
				switch line {
				case "READY=1":
					p.Ready = true
					if e = state.Save(recordPath(root), p); e != nil {
						return e
					}
					deadline = time.Now().Add(45 * time.Second)
				case "WATCHDOG=1":
					if p.Ready {
						deadline = time.Now().Add(45 * time.Second)
					}
				case "STOPPING=1":
					p.Ready = false
					_ = state.Save(recordPath(root), p)
				}
			}
		case <-tick.C:
			if time.Now().After(deadline) {
				// Kill immediately on watchdog timeout: no unmetered grace period.
				_ = x.cmd.Process.Kill()
				_ = a.cmd.Process.Kill()
				return ErrService
			}
		}
	}
}

// DetachedUpgrade is not parent-death bound: it must survive the stop it initiates.
func DetachedUpgrade(root, path, version string) error {
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND | syscall.O_NOFOLLOW
	log, e := os.OpenFile(filepath.Join(root, "state", "upgrade.log"), flags, 0600)
	if e != nil {
		return ErrService
	}
	defer log.Close()
	c := exec.Command("bash", path, "--upgrade", "--root", root, "--version", version)
	c.Dir, c.Env = root, cleanEnv()
	c.Stdout, c.Stderr = log, log
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if e = c.Start(); e != nil {
		return ErrService
	}
	go func() { _ = c.Wait() }()
	return nil
}

// PID is useful for operator inspection; never use an unvalidated PID to stop services.
func PID(root string) string {
	p, e := readProcess(root)
	if e != nil || !alive(p) {
		return "stopped"
	}
	return strconv.Itoa(p.PID)
}
