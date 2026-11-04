package types

import (
	"net"
	"testing"
)

// TestListenIsBoundWhenItCallsBack dials the address from Listen's callback,
// and from a "listening" listener, and requires every dial to connect.
//
// Listen started the server on a goroutine and called back at once, so the
// callback and "listening" could run before the port was bound, and a client
// started from them was refused (one start in ten on an idle machine).
func TestListenIsBoundWhenItCallsBack(t *testing.T) {
	for i := range 200 {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := ln.Addr().String()
		_ = ln.Close()

		server := NewWebServer(nil)
		var dialErrs []error
		dial := func(...any) {
			conn, err := net.Dial("tcp", addr)
			if err != nil {
				dialErrs = append(dialErrs, err)
				return
			}
			_ = conn.Close()
		}
		_ = server.On("listening", dial)
		server.Listen(addr, func() { dial() })
		_ = server.Close(nil)

		if len(dialErrs) > 0 {
			t.Fatalf("start %d: dialing %s once Listen reported listening: %v", i, addr, dialErrs)
		}
	}
}
