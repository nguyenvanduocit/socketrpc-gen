// Command goserver hosts the generated Go bindings for the optional/nullable
// contract.
//
// Like tests/fixtures/json-value/goserver it implements nothing but the
// generated ServerHandler interface. What it adds is the one thing the contract
// is about: the handler sees an optional boolean as *bool and a nullable enum as
// *rpc.Status, so it can say exactly what arrived as nil and what arrived as a
// value, `false` included.
//
// The `rpc` package is written into ./rpc by the test before `go build` runs.
//
// The server binds 127.0.0.1:0 and prints "LISTENING <host:port>" on stdout once
// the listener is up; that line is the readiness signal the Bun test waits on.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zishang520/socket.io/servers/socket/v3"

	"socketrpc.optionalnullable.test/rpc"
)

type handler struct{}

// HandleEcho hands the account back untouched, so whatever the test reads is
// what the generated types decoded and then encoded again.
func (handler) HandleEcho(_ context.Context, account rpc.Account) (rpc.Account, error) {
	return account, nil
}

// HandleDescribe renders each nilable argument as "nil" or its value. A bool
// pointer to false prints "false": the handler must be able to tell it apart from
// an argument that never arrived.
func (handler) HandleDescribe(_ context.Context, flag *bool, status *rpc.Status) (string, error) {
	return fmt.Sprintf("flag=%s status=%s", spell(flag), spell(status)), nil
}

func spell[T any](value *T) string {
	if value == nil {
		return "nil"
	}
	return fmt.Sprint(*value)
}

func serve(raw *socket.Socket) {
	if _, err := rpc.BindServer(raw, handler{}); err != nil {
		fmt.Fprintf(os.Stderr, "bind server: %v\n", err)
	}
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	ioServer := socket.NewServer(nil, nil)
	ioServer.On("connection", func(clients ...any) {
		raw, ok := clients[0].(*socket.Socket)
		if !ok {
			return
		}
		serve(raw)
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
