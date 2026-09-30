// Package state provides owner-only atomic JSON replacement, file and directory fsync,
// and a process lock shared by install/run/rotate. No state is kept outside --root.
package state

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var ErrIO = errors.New("local state operation failed")
var ErrLocked = errors.New("agent root is in use; stop agent before modifying installation")

func Root(s string) (string, error) {
	if !filepath.IsAbs(s) || filepath.Clean(s) == "/" || strings.ContainsAny(s, "\x00\r\n") {
		return "", ErrIO
	}
	return filepath.Clean(s), nil
}
func Prepare(root string) error {
	if _, e := Root(root); e != nil {
		return e
	}
	for _, d := range []string{root, filepath.Join(root, "config"), filepath.Join(root, "state")} {
		if e := os.MkdirAll(d, 0700); e != nil {
			return ErrIO
		}
		st, e := os.Lstat(d)
		if e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return ErrIO
		}
		if e = os.Chmod(d, 0700); e != nil {
			return ErrIO
		}
	}
	return nil
}
func Lock(root string) (*os.File, error) {
	p := filepath.Join(root, "state", "agent.lock")
	fd, e := syscall.Open(p, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return nil, ErrIO
	}
	f := os.NewFile(uintptr(fd), p)
	if e = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, ErrLocked
	}
	return f, nil // flock is released on Close and process death.
}
func Atomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, e := os.CreateTemp(dir, ".atomic-*")
	if e != nil {
		return ErrIO
	}
	name := f.Name()
	defer os.Remove(name)
	fail := func() error { f.Close(); return ErrIO }
	if e = f.Chmod(0600); e != nil {
		return fail()
	}
	if _, e = f.Write(data); e != nil {
		return fail()
	}
	if e = f.Sync(); e != nil {
		return fail()
	}
	if e = f.Close(); e != nil {
		return ErrIO
	}
	if e = os.Rename(name, path); e != nil {
		return ErrIO
	}
	d, e := os.Open(dir)
	if e != nil {
		return ErrIO
	}
	defer d.Close()
	if e = d.Sync(); e != nil {
		return ErrIO
	}
	return nil
}
func Save(path string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return ErrIO
	}
	return Atomic(path, append(b, '\n'))
}
func Load(path string, v any) error {
	// O_NOFOLLOW closes the lstat/open race; reject permissive files, not just writes.
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		if errors.Is(e, syscall.ENOENT) {
			return os.ErrNotExist
		}
		return ErrIO
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1<<20 {
		return ErrIO
	}
	dec := json.NewDecoder(io.LimitReader(f, 1<<20))
	dec.DisallowUnknownFields()
	if e = dec.Decode(v); e != nil {
		return ErrIO
	}
	if e = dec.Decode(new(any)); e != io.EOF {
		return ErrIO
	}
	return nil
}
