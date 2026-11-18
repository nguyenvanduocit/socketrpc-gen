// Command goserver is a handcrafted Socket.IO server that speaks the
// socketrpc-gen wire protocol. It exists so tests/go-wire.integration.test.ts can
// drive the *generated TypeScript client* against a non-TypeScript peer and prove
// the protocol is a real wire contract rather than a JS-to-JS convention.
//
// Nothing here imports the generator. Every event name, argument order and
// acknowledgement shape is written out by hand from ../define.ts, which is the
// point: if the generated client and this file agree, the protocol is portable.
//
// Wire contract, as implemented below:
//
//   - A value-returning call arrives as [args..., ack]. socket.io appends the ack
//     only when the client's packet carried an ack id. Reply with exactly ONE
//     element: ack([]any{result}, nil).
//   - A fire-and-forget call arrives as [args...] with no ack appended.
//   - A failure is not a transport error: reply through the same ack slot with a
//     branded RpcError object (see rpcError below).
//   - Calling into the client mirrors this: Emit for fire-and-forget,
//     Timeout(d).EmitWithAck(...) for a value-returning call.
//
// The server binds 127.0.0.1:0 and prints "LISTENING <host:port>" on stdout once
// the listener is up; that line is the readiness signal the Bun test waits on.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// askTimeout bounds a server→client call. Deliberately shorter than the Bun
// test's own timeouts so a hung client surfaces as a Go-side error, not a hang.
const askTimeout = 2 * time.Second

func appendUvarint(buf []byte, v uint64) []byte {
	for v >= 0x80 {
		buf = append(buf, byte(v)|0x80)
		v >>= 7
	}
	return append(buf, byte(v))
}

func readUvarint(data []byte) (uint64, int) {
	var out uint64
	for i := 0; i < len(data) && i < 10; i++ {
		b := data[i]
		carry := uint64(b & 0x7f)
		if i == 9 && carry > 1 {
			return 0, -1
		}
		out |= carry << (7 * uint(i))
		if (b & 0x80) == 0 {
			return out, i + 1
		}
	}
	return 0, 0
}

func appendPostcardString(buf []byte, s string) []byte {
	buf = appendUvarint(buf, uint64(len(s)))
	return append(buf, s...)
}

func encodeString(s string) []byte {
	return appendPostcardString(nil, s)
}

func encodeOkString(s string) []byte {
	return appendPostcardString([]byte{0}, s)
}

func encodeOkTwoStrings(a, b string) []byte {
	buf := appendPostcardString([]byte{0}, a)
	return appendPostcardString(buf, b)
}

func encodeOkStringSlice(items []string) []byte {
	buf := appendUvarint([]byte{0}, uint64(len(items)))
	for _, item := range items {
		buf = appendPostcardString(buf, item)
	}
	return buf
}

func encodeErr(code, message, method string, data any) []byte {
	buf := appendPostcardString([]byte{1}, code)
	buf = appendPostcardString(buf, message)
	if method == "" {
		buf = append(buf, 0)
	} else {
		buf = append(buf, 1)
		buf = appendPostcardString(buf, method)
	}
	if data == nil {
		buf = append(buf, 0)
	} else {
		raw, _ := json.Marshal(data)
		buf = append(buf, 1)
		buf = appendPostcardString(buf, string(raw))
	}
	return buf
}

func asBytes(value any) ([]byte, bool) {
	switch v := value.(type) {
	case []byte:
		return v, true
	case interface{ Bytes() []byte }:
		return v.Bytes(), true
	default:
		return nil, false
	}
}

func decodePostcardString(data []byte) string {
	strLen, n := readUvarint(data)
	if n <= 0 || uint64(len(data)-n) < strLen {
		return ""
	}
	return string(data[n : n+int(strLen)])
}

// splitAck separates the trailing acknowledgement callback socket.io appends when
// the inbound packet carried an ack id. socket.Ack is an alias for
// func([]any, error), so the type assertion matches the value the library appends.
// Fire-and-forget calls arrive without one and yield a nil ack.
func splitAck(args []any) ([]any, socket.Ack) {
	if len(args) == 0 {
		return args, nil
	}
	if ack, ok := args[len(args)-1].(socket.Ack); ok {
		return args[:len(args)-1], ack
	}
	return args, nil
}

// argString reads a positional Postcard string argument.
func argString(args []any, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	if data, ok := asBytes(args[i]); ok {
		return decodePostcardString(data)
	}
	s, _ := args[i].(string)
	return s
}

func replyString(args []any, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	if data, ok := asBytes(args[i]); ok && len(data) > 0 && data[0] == 0 {
		return decodePostcardString(data[1:])
	}
	return argString(args, i)
}

// session is the per-connection state the handlers share.
type session struct {
	mu    sync.Mutex
	notes []string
}

func (s *session) record(note string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notes = append(s.notes, note)
}

func (s *session) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.notes))
	copy(out, s.notes)
	return out
}

// wire registers every handler from ServerFunctions in ../define.ts.
//
// Listeners run on a queue that the library serializes per socket ("mimics
// Node.js's event loop"), so any handler that waits — sleeping, or awaiting a
// client acknowledgement — runs its body in a goroutine. Blocking inline would
// stall every later event on the same connection.
func wire(client *socket.Socket) {
	state := &session{}

	// echo: the ordinary success path — a value-returning call answered with an object.
	client.On("echo", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		ack([]any{encodeOkTwoStrings(argString(params, 0), argString(params, 1))}, nil)
	})

	// failTyped: a failure travels through the ack slot as a branded error, with a
	// non-standard code and a data payload, so the client sees a typed rejection
	// rather than a transport fault.
	client.On("failTyped", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		reason := argString(params, 0)
		ack([]any{encodeErr(
			"GO_REFUSED",
			"go server refused: "+reason,
			"failTyped",
			map[string]any{"reason": reason},
		)}, nil)
	})

	// note: fire-and-forget. A void signature must arrive with no ack appended;
	// recording the violation lets the client assert that from the other end.
	client.On("note", func(args ...any) {
		params, ack := splitAck(args)
		text := argString(params, 0)
		if ack != nil {
			state.record("UNEXPECTED_ACK:" + text)
			return
		}
		state.record(text)
	})

	// readNotes: reads back what `note` delivered, making fire-and-forget observable.
	client.On("readNotes", func(args ...any) {
		if _, ack := splitAck(args); ack != nil {
			ack([]any{encodeOkStringSlice(state.snapshot())}, nil)
		}
	})

	// neverAck: the ack is deliberately dropped, leaving the client to time out on
	// its own clock.
	client.On("neverAck", func(args ...any) {})

	// dropWhileInFlight: close the connection with the call still outstanding, so
	// the client settles it from the disconnect rather than the timeout.
	client.On("dropWhileInFlight", func(args ...any) {
		go func() {
			time.Sleep(50 * time.Millisecond)
			client.Disconnect(true)
		}()
	})

	// receipt: a success that happens to carry `message` and `code`.
	client.On("receipt", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		ack([]any{encodeOkTwoStrings("receipt for "+argString(params, 0), "PAID")}, nil)
	})

	// roundTrip: the bidirectional path. Go pushes a fire-and-forget `notify`, then
	// makes a value-returning `ask` call into the client, then folds the client's
	// answer into the reply to the original call.
	client.On("roundTrip", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		question := argString(params, 0)

		go func() {
			// Fire-and-forget into the client: no ack callback appended.
			if err := client.Emit("notify", encodeString("pushed:"+question)); err != nil {
				ack([]any{encodeErr("INTERNAL_ERROR", err.Error(), "roundTrip", nil)}, nil)
				return
			}

			// Value-returning call into the client. Timeout() sets a flag consumed by
			// the very next emit on this socket, so the two must stay adjacent.
			answered := make(chan []any, 1)
			failed := make(chan error, 1)
			client.Timeout(askTimeout).EmitWithAck("ask", encodeString(question))(func(reply []any, err error) {
				if err != nil {
					failed <- err
					return
				}
				answered <- reply
			})

			select {
			case reply := <-answered:
				ack([]any{encodeOkString("go saw: " + replyString(reply, 0))}, nil)
			case err := <-failed:
				ack([]any{encodeErr("INTERNAL_ERROR", err.Error(), "roundTrip", nil)}, nil)
			}
		}()
	})
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	ioServer := socket.NewServer(nil, nil)
	ioServer.On("connection", func(clients ...any) {
		client, ok := clients[0].(*socket.Socket)
		if !ok {
			return
		}
		wire(client)
	})

	mux := http.NewServeMux()
	mux.Handle("/socket.io/", ioServer.ServeHandler(nil))
	server := &http.Server{Handler: mux}

	serveErr := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	// Readiness. os.Stdout is unbuffered, so this line reaches the parent as soon
	// as the listener is accepting — the Bun test blocks on it before connecting.
	fmt.Printf("LISTENING %s\n", listener.Addr().String())

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	// A closed stdin means the Bun test died without killing us. Exit rather than
	// linger as an orphan holding a port.
	parentGone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(parentGone)
	}()

	select {
	case err := <-serveErr:
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	case <-signals:
	case <-parentGone:
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
