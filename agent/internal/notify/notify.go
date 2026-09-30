// Package notify implements systemd sd_notify without a libsystemd dependency.
package notify

import (
	"errors"
	"net"
	"os"
	"strings"
	"time"
)

var ErrNotify = errors.New("systemd notification failed")

func Send(message string) error {
	socket := os.Getenv("NOTIFY_SOCKET")
	if socket == "" {
		return nil
	}
	if strings.HasPrefix(socket, "@") {
		socket = "\x00" + socket[1:]
	}
	c, e := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: socket, Net: "unixgram"})
	if e != nil {
		return ErrNotify
	}
	defer c.Close()
	if e = c.SetWriteDeadline(time.Now().Add(time.Second)); e != nil {
		return ErrNotify
	}
	if _, e = c.Write([]byte(message)); e != nil {
		return ErrNotify
	}
	return nil
}
