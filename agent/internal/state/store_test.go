package state

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicModeAndLock(t *testing.T) {
	root := t.TempDir()
	if e := Prepare(root); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(root, "state", "usage.json")
	for i := 0; i < 5; i++ {
		if e := Save(p, map[string]int{"sequence": i}); e != nil {
			t.Fatal(e)
		}
	}
	var v map[string]int
	if e := Load(p, &v); e != nil || v["sequence"] != 4 {
		t.Fatal(e, v)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	l, e := Lock(root)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = Lock(root); !errors.Is(e, ErrLocked) {
		t.Fatal(e)
	}
	l.Close()
	l, e = Lock(root)
	if e != nil {
		t.Fatal(e)
	}
	l.Close()
	files, _ := filepath.Glob(filepath.Join(root, "state", ".atomic-*"))
	if len(files) != 0 {
		t.Fatal("temporary files retained")
	}
}
func TestRefuseUnsafeAndMalformedFiles(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "data")
	var v struct {
		Sequence int `json:"sequence"`
	}
	for _, b := range []string{"not-json", "{\"sequence\":1} {}", "{\"sequence\":1,\"secret\":1}"} {
		if e := os.WriteFile(p, []byte(b), 0600); e != nil {
			t.Fatal(e)
		}
		if Load(p, &v) != ErrIO {
			t.Fatal("corrupt state accepted")
		}
	}
	_ = os.WriteFile(p, []byte("{\"sequence\":1}"), 0600)
	_ = os.Chmod(p, 0644)
	if Load(p, &v) != ErrIO {
		t.Fatal("world-readable state")
	}
	link := filepath.Join(root, "link")
	_ = os.Symlink(p, link)
	if Load(link, &v) != ErrIO {
		t.Fatal("symlink read accepted")
	}
}
