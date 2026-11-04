package socket

import (
	"bytes"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/parsers/engine/packet"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/engine"
)

// A client may emit as soon as it reads its CONNECT packet. The server must route packets for that namespace by then;
// otherwise the first event finds no socket and the connection is closed as an invalid state. The test holds the
// server right after the CONNECT packet left it (the engine's drain), the widest that window can be, and sends the
// event then.
func TestAnEventSentOnTheConnectPacketReachesTheSocket(t *testing.T) {
	eio := engine.NewServer(nil)
	release := make(chan struct{})
	var releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(release) }) }
	_ = eio.On("connection", func(args ...any) {
		conn := args[0].(engine.Socket)
		var mu sync.Mutex
		var connectSent, held bool
		_ = conn.On("flush", func(args ...any) {
			for _, p := range args[0].([]*packet.Packet) {
				if p.Type == packet.MESSAGE && startsWith(p.Data, "0") { // a Socket.IO CONNECT
					mu.Lock()
					connectSent = true
					mu.Unlock()
				}
			}
		})
		_ = conn.On("drain", func(...any) {
			mu.Lock()
			hold := connectSent && !held
			held = held || hold
			mu.Unlock()
			if hold {
				select {
				case <-release:
				case <-time.After(5 * time.Second):
				}
			}
		})
	})

	server := NewServer(nil, nil)
	server.Use(func(_ *Socket, next func(*ExtendedError)) { next(nil) })
	_ = server.On("connection", func(args ...any) {
		socket := args[0].(*Socket)
		_ = socket.On("echo", func(values ...any) {
			if ack, ok := values[len(values)-1].(func([]any, error)); ok {
				ack([]any{"back"}, nil)
			}
		})
	})
	server.Bind(eio)
	httpServer := httptest.NewServer(eio)
	t.Cleanup(func() {
		resume()
		server.Close(nil)
		httpServer.Close()
	})

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/socket.io/?EIO=4&transport=websocket", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	frames, ended := make(chan string, 8), make(chan error, 1)
	go func() {
		for {
			_, payload, err := client.ReadMessage()
			if err != nil {
				ended <- err
				return
			}
			if string(payload) != "2" { // engine pings are not what the test waits for
				frames <- string(payload)
			}
		}
	}()
	next := func(what string) string {
		t.Helper()
		select {
		case f := <-frames:
			return f
		case err := <-ended:
			t.Fatalf("the connection ended waiting for %s: %v", what, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("no %s came", what)
		}
		return ""
	}
	if open := next("engine OPEN"); !strings.HasPrefix(open, "0{") {
		t.Fatalf("engine OPEN = %q", open)
	}
	if err := client.WriteMessage(websocket.TextMessage, []byte(`40`)); err != nil {
		t.Fatal(err)
	}
	if connect := next("CONNECT"); !strings.HasPrefix(connect, "40{") {
		t.Fatalf("CONNECT = %q", connect)
	}
	if err := client.WriteMessage(websocket.TextMessage, []byte(`421["echo"]`)); err != nil {
		t.Fatal(err)
	}
	select { // the server is still held: the event waits for it, and the connection stays
	case f := <-frames:
		t.Fatalf("answered %q while the server was held", f)
	case err := <-ended:
		t.Fatalf("the connection ended on the first event: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	resume()
	if ack := next("the event's ack"); ack != `431["back"]` {
		t.Fatalf("ack = %q", ack)
	}
}

// startsWith says whether an engine packet's payload begins with prefix, leaving the payload readable.
func startsWith(data io.Reader, prefix string) bool {
	if data == nil {
		return false
	}
	if s, ok := data.(interface{ String() string }); ok {
		return strings.HasPrefix(s.String(), prefix)
	}
	if b, ok := data.(interface{ Bytes() []byte }); ok {
		return bytes.HasPrefix(b.Bytes(), []byte(prefix))
	}
	return false
}
